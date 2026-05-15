/**
 * monday/mapper.ts
 *
 * Rule-based mapping from a Monday.com board item's column values
 * to the LeadSchema field shape.
 *
 * Strategy (in priority order):
 *   1. mapping.json explicit override  — user declared "this column → this field"
 *   2. Keyword auto-detection          — normalized column title matches a pattern
 *   3. Item name fallback              — item.name is used as `company` if nothing matched
 *   4. mapping.json defaults           — hardcoded fallbacks (e.g. aeEmail)
 *
 * The mapper returns a MappedLead containing:
 *   - `fields`              : the raw extracted values (pre-Zod)
 *   - `consumedColumnTitles`: columns that were matched (skipped by synthesizer)
 *   - `columnFieldMap`      : column title → the Lead field it was actually mapped to
 *   - `unmappedColumns`     : columns with text but no match (fed to AI synthesizer)
 */

import type { MondayItem, MondayColumnValue, ColumnMapping, MappedLead } from "./types.js";

// ---------- Global skip list ----------
// Columns whose normalized title includes ANY of these substrings are silently
// consumed and never mapped to a Lead field or sent to the AI synthesizer.
//
// Only truly universal Monday system/metadata columns go here.
// Board-specific noise (headcount, scoring, file links) belongs in
// mapping.json under "skipColumns" so it stays close to the board config.

const GLOBAL_SKIP_PATTERNS: string[] = [
  "creation log",
  "last updated",
  "item id",
];

// ---------- Pattern registry ----------
// Each key is a LeadSchema field name.
// Values are lowercase substrings; if ANY of them appear in the
// normalized column title, that column is assigned to this field.
//
// IMPORTANT — patterns must be specific enough to avoid false positives.
// "Company Size (LinkedIn)" contains "company" but should NOT match the
// `company` field. Bare single-word patterns are risky; prefer phrases.

const FIELD_PATTERNS: Record<string, string[]> = {
  // "company name" / "account name" are specific; bare "company" would
  // false-positive on "Company Size", "Company LinkedIn", "Partner Company".
  company:           ["company name", "account name", "account"],
  website:           ["website url", "website", "domain", "homepage"],
  prospectName:      ["prospect name", "contact name", "primary contact", "poc name"],
  prospectTitle:     ["prospect title", "contact title", "job title", "poc title"],
  aeName:            ["ae name", "account executive name", "rep name", "salesperson"],
  aeEmail:           ["ae email", "rep email", "account executive email"],
  // "meeting" alone false-positives on "Initial Meeting Type"; prefer phrases.
  meetingAt:         ["meeting date", "meeting at", "next meeting", "call date",
                      "scheduled date", "initial meeting"],
  dealStage:         ["deal stage", "pipeline stage", "stage", "status"],
  productFocus:      ["product focus", "service focus", "core competency"],
  hypothesis:        ["hypothesis", "pain hypothesis", "thesis", "our hypothesis"],
  callObjective:     ["call objective", "meeting objective", "call goal", "meeting goal"],
  meetingContext:    ["meeting context", "meeting notes", "background", "context", "notes"],
  prospectArchetype: ["prospect archetype", "archetype", "company type", "prospect type"],
  meetingType:       ["meeting type", "call type", "initial meeting type"],
  engagementShape:   ["engagement shape", "engagement type", "scope", "contract type"],
  introSource:       ["intro source", "lead source", "introduction", "how we met"],
  introContext:      ["intro context", "introduction context", "intro notes",
                      "referrer", "event name"],
  audience:          ["audience", "buyer persona", "primary audience"],
  competitiveContext:["competitive context", "competitors", "competition"],
  excludeKeywords:   ["exclude keywords", "disambiguation", "exclusions"],
};

// ---------- Value normalizers ----------

/** Maps Monday status label → Lead dealStage enum. Covers this board's actual labels. */
function normalizeDealStage(raw: string): "cold" | "warm" | "evaluation" | undefined {
  const s = raw.toLowerCase().trim();
  const MAP: Record<string, "cold" | "warm" | "evaluation"> = {
    // Generic
    cold: "cold", new: "cold", prospect: "cold", prospecting: "cold",
    outreach: "cold", uncontacted: "cold", "not started": "cold",
    warm: "warm", active: "warm", "in progress": "warm", engaged: "warm",
    interested: "warm", working: "warm", qualified: "warm",
    evaluation: "evaluation", demo: "evaluation", proposal: "evaluation",
    comparing: "evaluation", "vendor eval": "evaluation",
    negotiation: "evaluation", reviewing: "evaluation", "short list": "evaluation",
    // This board's actual Status column values
    "potential future": "cold",
    "ghosted": "cold",
    "no project at this time": "cold",
    "determined not a fit": "cold",
    "researching": "cold",           // early-stage prospect being evaluated
    "in-discussions (needs, budget, fit)": "warm",
    "in discussions": "warm",
    "contract signed": "warm",       // already a client; warm is closest
    "active client": "warm",
    "long sales cycle": "warm",      // engaged but extended timeline
    "proposal sent": "evaluation",
    "proposal review": "evaluation",
  };
  if (MAP[s]) return MAP[s];
  // Partial hit — catches label variants like "In-Discussions (needs, budget, fit)"
  for (const [key, val] of Object.entries(MAP)) {
    if (s.includes(key)) return val;
  }
  return undefined;
}

/**
 * Maps Company Type label → Lead prospectArchetype enum.
 * Covers generic AEC terms AND this board's labels (Local, Commercial, State).
 */
function normalizeArchetype(
  raw: string
): "aec_firm" | "aec_vendor" | "other" | undefined {
  const s = raw.toLowerCase().trim();
  // AEC firms
  if (/aec.?firm|general.?contractor|design.?firm|architecture|engineering.?firm|owner.?operator/.test(s)) return "aec_firm";
  // This board uses "Commercial" for commercial construction contractors
  if (s === "commercial") return "aec_firm";
  // AEC software vendors
  if (/aec.?vendor|software|saas|platform|tech.?vendor|isv/.test(s)) return "aec_vendor";
  // Government / non-profit / local entities
  if (s === "state" || s === "federal" || s === "government" || s === "non-profit" || s === "nonprofit") return "other";
  // "Local" — local businesses; not enough info to say AEC, default to other
  if (s === "local") return "other";
  if (s === "other" || s === "general") return "other";
  return undefined;
}

/** Maps meeting type label → Lead meetingType enum. */
function normalizeMeetingType(
  raw: string
): "first_intro" | "discovery" | "proposal_review" | "renewal" | "partnership_explore" | undefined {
  const s = raw.toLowerCase().trim();
  if (s === "tbd" || s === "") return undefined;
  const MAP: Record<string, "first_intro" | "discovery" | "proposal_review" | "renewal" | "partnership_explore"> = {
    "first intro": "first_intro", "first_intro": "first_intro",
    intro: "first_intro", introduction: "first_intro", "initial call": "first_intro",
    discovery: "discovery", "deep dive": "discovery", "deep-dive": "discovery",
    // "Problem-Driven" is this board's label for a discovery-style meeting
    "problem-driven": "discovery", "problem driven": "discovery",
    "proposal review": "proposal_review", "proposal_review": "proposal_review",
    proposal: "proposal_review", "review proposal": "proposal_review",
    renewal: "renewal", "contract renewal": "renewal", "renewal call": "renewal",
    "partnership explore": "partnership_explore", "partnership_explore": "partnership_explore",
    partnership: "partnership_explore", "partner call": "partnership_explore",
  };
  if (MAP[s]) return MAP[s];
  for (const [key, val] of Object.entries(MAP)) {
    if (s.includes(key)) return val;
  }
  return undefined;
}

/** Maps intro source label → Lead introSource enum. */
function normalizeIntroSource(
  raw: string
): "inbound" | "referral" | "event" | "cold_outbound" | "reactivation" | undefined {
  const s = raw.toLowerCase().trim();
  if (s === "tbd" || s === "") return undefined;
  const MAP: Record<string, "inbound" | "referral" | "event" | "cold_outbound" | "reactivation"> = {
    inbound: "inbound", "inbound lead": "inbound", "website form": "inbound",
    referral: "referral", referred: "referral", "word of mouth": "referral",
    // This board uses "Organic" for referrals through the network
    organic: "referral",
    event: "event", conference: "event", tradeshow: "event", "trade show": "event",
    // This board uses "Met at Event"
    "met at event": "event", "met at conference": "event",
    "cold outbound": "cold_outbound", cold_outbound: "cold_outbound",
    outbound: "cold_outbound", "cold email": "cold_outbound", "cold call": "cold_outbound",
    reactivation: "reactivation", "re-engaged": "reactivation", "old lead": "reactivation",
  };
  if (MAP[s]) return MAP[s];
  for (const [key, val] of Object.entries(MAP)) {
    if (s.includes(key)) return val;
  }
  return undefined;
}

/** Maps audience label → Lead audience enum. */
function normalizeAudience(
  raw: string
): "ceo" | "cto" | "cfo" | "coo" | "cro" | "generic" | undefined {
  const s = raw.toLowerCase().trim();
  if (s.includes("ceo") || s.includes("chief executive")) return "ceo";
  if (s.includes("cto") || s.includes("chief technology")) return "cto";
  if (s.includes("cfo") || s.includes("chief financial")) return "cfo";
  if (s.includes("coo") || s.includes("chief operating")) return "coo";
  if (s.includes("cro") || s.includes("chief revenue")) return "cro";
  if (s === "generic") return "generic";
  return undefined;
}

/** Parse a Monday date text ("YYYY-MM-DD") or datetime to ISO 8601. */
function normalizeDateToISO(raw: string): string | undefined {
  if (!raw || raw.trim() === "") return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return `${raw.trim()}T00:00:00Z`;
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d.toISOString();
  return undefined;
}

/**
 * Extract a clean URL from a Monday link column.
 *
 * Monday link columns store JSON in `value`: { "url": "https://...", "text": "Here" }
 * The display `text` field concatenates them as "Here - https://..." which is not
 * a valid URL. We parse the JSON first; fall back to regex extraction from text.
 */
function extractUrl(col: MondayColumnValue): string | undefined {
  // 1. Parse the raw JSON value (most reliable)
  if (col.value) {
    try {
      const parsed = JSON.parse(col.value) as { url?: string };
      const url = parsed.url?.trim();
      if (url && /^https?:\/\//i.test(url)) return url;
    } catch { /* fall through */ }
  }
  // 2. Regex-extract a URL from the display text ("Here - https://...")
  const raw = col.text?.trim() ?? "";
  const match = raw.match(/https?:\/\/[^\s"'<>]+/i);
  if (match) return match[0].replace(/\/$/, "");
  return undefined;
}

/** Split a comma/newline/semicolon-separated string into an array. */
function splitList(raw: string): string[] {
  return raw.split(/[,\n;]+/).map((s) => s.trim()).filter(Boolean);
}

// ---------- Core mapping logic ----------

/** Lowercase + collapse whitespace for consistent matching. */
function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Auto-detect which Lead field a column title maps to via FIELD_PATTERNS. */
function detectFieldFromTitle(title: string): string | undefined {
  const normalized = normalizeTitle(title);
  for (const [field, patterns] of Object.entries(FIELD_PATTERNS)) {
    for (const pattern of patterns) {
      if (normalized.includes(pattern)) return field;
    }
  }
  return undefined;
}

/**
 * Extract and normalize a value for a specific Lead field from a column.
 * Returns undefined if the text is empty or the value can't be interpreted.
 */
function extractValue(field: string, col: MondayColumnValue): unknown {
  const raw = col.text?.trim() ?? "";

  switch (field) {
    case "dealStage":         return raw ? normalizeDealStage(raw) : undefined;
    case "prospectArchetype": return raw ? normalizeArchetype(raw) : undefined;
    case "meetingType":       return raw ? normalizeMeetingType(raw) : undefined;
    case "introSource":       return raw ? normalizeIntroSource(raw) : undefined;
    case "audience":          return raw ? normalizeAudience(raw) : undefined;
    case "meetingAt":         return raw ? normalizeDateToISO(raw) : undefined;
    case "website":           return extractUrl(col);
    case "competitiveContext":return raw ? splitList(raw) : undefined;
    case "excludeKeywords":   return raw ? splitList(raw) : undefined;
    // introContext: strip noise values that mean "nothing here"
    case "introContext": {
      if (!raw || /^(n\/a|tbd|none|-)$/i.test(raw)) return undefined;
      return raw;
    }
    default:
      return raw || undefined;
  }
}

// ---------- Public API ----------

/**
 * Map a Monday board item to a partial Lead object.
 *
 * @param item     The Monday item to map
 * @param mapping  Optional column mapping override (from monday/mapping.json)
 */
export function mapItemToLead(item: MondayItem, mapping?: ColumnMapping): MappedLead {
  const fields: Record<string, unknown> = {};
  const consumedColumnTitles = new Set<string>();
  const columnFieldMap = new Map<string, string>();  // title → actual Lead field used
  const skippedColumnTitles = new Set<string>();     // titles silently dropped by skip rules
  const unmappedColumns: MondayColumnValue[] = [];

  // Build reverse lookup: normalized column title → Lead field (from mapping.json overrides)
  const overrideByTitle = new Map<string, string>();
  if (mapping?.columnMap) {
    for (const [leadField, colTitle] of Object.entries(mapping.columnMap)) {
      if (colTitle) overrideByTitle.set(normalizeTitle(colTitle), leadField);
    }
  }

  // Build the skip set: global patterns + board-specific titles from mapping.json.
  // Skipped columns are consumed (invisible to the synthesizer) but never mapped to
  // any Lead field. Employee headcount lives here — the Researcher fetches current
  // figures from Perplexity/LinkedIn independently during the prep run.
  const skipTitles = new Set<string>(
    (mapping?.skipColumns ?? []).map(normalizeTitle)
  );
  const isSkipped = (title: string): boolean => {
    const n = normalizeTitle(title);
    if (skipTitles.has(n)) return true;
    return GLOBAL_SKIP_PATTERNS.some((p) => n.includes(p));
  };

  for (const col of item.column_values) {
    const text = col.text?.trim() ?? "";

    // Priority 0: explicitly skipped columns — consume silently, no mapping, no AI
    if (isSkipped(col.title)) {
      consumedColumnTitles.add(col.title);
      skippedColumnTitles.add(col.title);
      // Intentionally NOT added to columnFieldMap — skipped columns are invisible
      continue;
    }

    // Priority 1: explicit override from mapping.json
    const overrideField = overrideByTitle.get(normalizeTitle(col.title));
    // Priority 2: keyword auto-detection
    const autoField = detectFieldFromTitle(col.title);

    const targetField = overrideField ?? autoField;

    if (targetField) {
      const value = extractValue(targetField, col);
      // Set only if we got a real value and haven't filled this field yet.
      if (value !== undefined && value !== null && !(targetField in fields)) {
        fields[targetField] = value;
      }
      consumedColumnTitles.add(col.title);
      columnFieldMap.set(col.title, targetField);
    } else if (text) {
      // Non-empty column with no match → give to AI synthesizer
      unmappedColumns.push(col);
    }
  }

  // Item name fallback: use as company if nothing else set it
  if (!fields["company"] && item.name) {
    fields["company"] = item.name;
  }

  // ---------- AE attribution ----------
  // Priority: Primary column (teamEmails lookup) → item creator → defaults
  //
  // The Primary column is a Monday "people" picker. Its text contains the
  // assignee's display name (e.g. "Spenser Chun"). We look that name up in
  // teamEmails to get the email — Monday's people columns don't expose email
  // directly in the column_values API response.
  //
  // The item creator (fetched via `creator { id name email }` in the GraphQL
  // query) always has an email and serves as a good second-tier fallback.
  if (!fields["aeName"] || !fields["aeEmail"]) {
    // 1. Primary column → teamEmails lookup
    const primaryCol = item.column_values.find(
      (cv) => normalizeTitle(cv.title) === "primary"
    );
    const primaryText = primaryCol?.text?.trim();
    if (primaryText && mapping?.teamEmails) {
      // People columns may list multiple names; take the first one.
      const firstName = primaryText.split(/[,;]+/)[0].trim();
      // Try exact (case-insensitive) match first, then substring match.
      const teamEmails = mapping.teamEmails;
      const exactEmail = Object.entries(teamEmails).find(
        ([name]) => name.toLowerCase() === firstName.toLowerCase()
      )?.[1];
      const partialEmail = exactEmail ?? Object.entries(teamEmails).find(
        ([name]) =>
          firstName.toLowerCase().includes(name.toLowerCase()) ||
          name.toLowerCase().includes(firstName.toLowerCase())
      )?.[1];
      if (partialEmail) {
        if (!fields["aeEmail"]) fields["aeEmail"] = partialEmail;
        if (!fields["aeName"]) fields["aeName"] = firstName;
      }
    }

    // 2. Item creator (has email natively from the Monday API)
    if (item.creator && (!fields["aeEmail"] || !fields["aeName"])) {
      if (!fields["aeEmail"]) fields["aeEmail"] = item.creator.email;
      if (!fields["aeName"]) fields["aeName"] = item.creator.name;
    }
  }

  // Apply defaults — only fills fields not already set by mapping or AE resolution
  if (mapping?.defaults) {
    for (const [key, value] of Object.entries(mapping.defaults)) {
      if (value !== undefined && value !== null && !(key in fields)) {
        fields[key] = value;
      }
    }
  }

  return { fields, consumedColumnTitles, columnFieldMap, skippedColumnTitles, unmappedColumns, itemName: item.name };
}

/**
 * Print a mapping report for a single item — shows which columns were
 * matched, to which Lead field, and what value was extracted.
 */
export function describeMappingResult(item: MondayItem, mapped: MappedLead): string {
  const lines: string[] = [`\nColumn mapping report for: ${item.name} (id: ${item.id})`];
  lines.push("─".repeat(60));

  for (const col of item.column_values) {
    const text = col.text?.trim() ?? "";
    const isSkipped = mapped.skippedColumnTitles.has(col.title);
    const isConsumed = mapped.consumedColumnTitles.has(col.title);

    if (isSkipped) {
      // Silently dropped — not mapped, not sent to AI
      lines.push(`  ⊘  "${col.title}" → [skipped]`);
    } else if (isConsumed) {
      // Show the actual Lead field it was mapped to
      const actualField = mapped.columnFieldMap.get(col.title) ?? "?";
      lines.push(`  ✓  "${col.title}" → ${actualField} = ${JSON.stringify(text).slice(0, 60)}`);
    } else if (text) {
      lines.push(`  ~  "${col.title}" → [unmapped, sent to AI] = ${JSON.stringify(text).slice(0, 60)}`);
    } else {
      lines.push(`  ·  "${col.title}" → [empty]`);
    }
  }

  lines.push("─".repeat(60));
  lines.push(`  Matched fields: ${Object.keys(mapped.fields).join(", ") || "(none)"}`);
  lines.push(`  Skipped columns: ${mapped.skippedColumnTitles.size}`);
  lines.push(`  Unmapped columns with data: ${mapped.unmappedColumns.length}`);

  return lines.join("\n");
}
