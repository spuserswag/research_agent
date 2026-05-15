/**
 * Deterministic verification — the anti-hallucination spine.
 *
 * This module is PURE TYPESCRIPT, no LLM calls. It runs BEFORE the LLM
 * QAVerifier in the orchestrator so that any claim the multi-agent
 * pipeline produced gets mechanically checked against source bytes
 * before the QAVerifier (or anyone else) can reason about it.
 *
 * The verifier's job is intentionally narrow: every claim that purports
 * to come from a source must include a verbatim quote, and that quote
 * must appear character-exact (modulo normalization) in the source's
 * snippet text. Claims that fail this check are stripped with a logged
 * reason — not edited, not "fixed", just dropped.
 *
 * Ported from the Python `prospect_brief` pipeline's verify.py /
 * relevance.py. Same rules, same failure cases.
 */

import type { DraftBrief, RiskSchema, SourcePack } from "../types.js";
import type { z } from "zod";

export const VERIFY_VERSION = "v1-2026-05-12-ts-port";

// ----------------------------------------------------------------------
// Normalization + substring match
// ----------------------------------------------------------------------

const _WS = /\s+/g;
const _SMART_QUOTES = /[“”‘’]/g; // " " ' '

/**
 * Lowercase, collapse whitespace, normalize smart quotes. Used on both
 * the quote and the source text before substring comparison.
 */
export function normalize(text: string): string {
  if (!text) return "";
  return text.replace(_SMART_QUOTES, '"').toLowerCase().replace(_WS, " ").trim();
}

/**
 * Does the quote appear as a substring of the source text (modulo
 * normalization)? Falls back to checking the quote without surrounding
 * quotation marks.
 */
export function quoteAppearsInSource(quote: string, sourceText: string): boolean {
  if (!quote || !sourceText) return false;
  const q = normalize(quote);
  const t = normalize(sourceText);
  if (t.includes(q)) return true;
  const qInner = q.replace(/^["']|["']$/g, "").trim();
  if (qInner && t.includes(qInner)) return true;
  return false;
}

/**
 * Search every source in a SourcePack for the quote. Returns the source
 * id whose snippet contains the quote, or null. Useful for verifying
 * that a claim's `supportingSourceIds` actually contain the evidence.
 */
export function findQuoteInPack(
  quote: string,
  pack: SourcePack,
): string | null {
  for (const src of pack.sources) {
    if (quoteAppearsInSource(quote, src.snippet)) return src.id;
  }
  return null;
}

// ----------------------------------------------------------------------
// Value-supported-by-quote checks
//
// The mechanical-substring rule guarantees the QUOTE is in the source.
// These additional checks ensure the STRUCTURED VALUE attached to the
// quote (founded year, HQ city, ownership class, etc.) is actually
// supported by the quote — not invented from it.
// ----------------------------------------------------------------------

const _FOUR_DIGIT_YEAR = /\b(1[89]\d{2}|20\d{2})\b/;

const _FOUNDING_CONTEXT = [
  "founded", "since", "established", "incorporated", "founding",
  "inception", "formed", "started in", "began in", "opened",
  "operating since", "in business since",
];

const _OWNERSHIP_CONTEXT = [
  "private", "privately", "publicly", "traded", "owned", "subsidiary",
  "holdings", "esop", "employee-owned", "family-owned", "family owned",
  "private equity", "venture-backed", "vc-backed", "bootstrapped",
];

const _HQ_INDICATORS = [
  "headquarter", "headquartered",
  "main office", "principal office", "corporate office",
  "primary office", "primary location",
  "based in", "based out of",
  "global headquarters", "company headquarters",
  "head office",
  "located in",
];

const _SECONDARY_OFFICE = [
  "second office", "additional office", "satellite office",
  "branch office", "regional office", "field office",
  "another location", "additional location", "second location",
];

const _RESELLER_PATTERNS = [
  "supplie",       // supplies / supplier / supplied
  "resell",        // resell / resells / reseller / reselling
  "distribut",     // distributes / distributor / distributing
  "powered by",
  "and other ",
  "in partnership with",
];

const _HEADCOUNT_CONTEXT = [
  "employee", "staff", "team", "people", "headcount", "workforce",
  "personnel", "associate", "worker", "fte",
];

const _PERSONAL_HISTORY = [
  "founder of", "co-founder of", "founded ",
  "previously at", "previously of", "former at",
  "former cto", "former ceo", "former coo", "former cfo",
  "ex-", "before founding", "before joining",
  "left to start", "spun out from",
  "alum of", "alumna of", "alumnus of",
];

const _CAGE_RE = /^[A-Z0-9]{5}$/i;
const _UEI_RE = /^[A-Z0-9]{12}$/i;
const _NAICS_RE = /\b\d{6}\b/;

const _THROUGHPUT_UNITS = [
  "scan", "scans", "site", "sites", "project", "projects",
  "deployment", "deployments", "install", "installs",
  "patient", "patients", "transaction", "transactions",
  "user", "users", "customer", "customers",
  "square feet", "sq ft", "sqft", "acres", "miles",
  "buildings", "units", "rooms", "events",
];

export type CompanyAttribute =
  | "founded_year"
  | "headquarters"
  | "office_locations"
  | "services_offered"
  | "specialties"
  | "primary_markets"
  | "employee_count_range"
  | "annual_revenue_range"
  | "industry_certifications"
  | "ownership_structure"
  | "mission_statement"
  | "stated_values"
  | "notable_clients"
  | "awards_recognition"
  | "community_involvement"
  | "cage_code"
  | "uei"
  | "naics_codes"
  | "technology_stack"
  | "operational_throughput";

export interface ValidationResult {
  ok: boolean;
  reason: string;
}

/**
 * The value's content tokens must mostly appear in the quote.
 * Drops short tokens (< 3 chars) to ignore noise like "of" / "is".
 */
function valueTokensInQuote(value: string, quote: string): boolean {
  const normQ = normalize(quote);
  const tokens = value
    .toLowerCase()
    .split(/[\s,/]+/)
    .filter((t) => t.length > 2);
  if (tokens.length === 0) return false;
  const hits = tokens.filter((t) => normQ.includes(t)).length;
  return hits / tokens.length >= 0.6;
}

/**
 * Stricter per-attribute validation. Drops claims where the structured
 * value isn't actually supported by the quote.
 */
export function validateCompanyAttribute(
  attribute: CompanyAttribute,
  value: string,
  quote: string,
  companyName?: string,
): ValidationResult {
  const normQ = normalize(quote);
  const normV = normalize(value);

  if (attribute === "founded_year") {
    const years = normV.match(_FOUR_DIGIT_YEAR);
    if (!years) {
      return { ok: false, reason: "founded_year value is not a 4-digit year" };
    }
    if (!normQ.includes(years[0])) {
      return {
        ok: false,
        reason: `year ${years[0]} not present in quote`,
      };
    }
    if (!_FOUNDING_CONTEXT.some((c) => normQ.includes(c))) {
      return {
        ok: false,
        reason:
          "year present in quote but quote lacks founding-context word " +
          "(founded/since/established/...)",
      };
    }
    return { ok: true, reason: "" };
  }

  if (attribute === "headquarters") {
    if (_SECONDARY_OFFICE.some((m) => normQ.includes(m))) {
      return {
        ok: false,
        reason:
          "quote names a secondary/satellite office — should be " +
          "office_locations, not headquarters",
      };
    }
    if (!_HQ_INDICATORS.some((i) => normQ.includes(i))) {
      return {
        ok: false,
        reason:
          "HQ quote lacks primary-location indicator " +
          "(headquartered/based in/main office/etc.)",
      };
    }
    return valueTokensInQuote(value, quote)
      ? { ok: true, reason: "" }
      : { ok: false, reason: "HQ value not present in quote" };
  }

  if (attribute === "ownership_structure") {
    if (!_OWNERSHIP_CONTEXT.some((c) => normQ.includes(c))) {
      return {
        ok: false,
        reason:
          "ownership quote lacks class word " +
          "(private/publicly/traded/owned/...)",
      };
    }
    if (
      ["public company", "public", "private company", "private"].includes(normV)
    ) {
      const corrob = [
        "publicly traded", "privately held", "publicly listed",
        "private equity", "wholly owned", "subsidiary of",
        "nyse", "nasdaq", "lse", "stock exchange",
      ];
      if (!corrob.some((c) => normQ.includes(c))) {
        return {
          ok: false,
          reason:
            "bare 'public/private company' with no corroborator " +
            "(publicly traded / ticker / parent company)",
        };
      }
    }
    return valueTokensInQuote(value, quote)
      ? { ok: true, reason: "" }
      : { ok: false, reason: "ownership value not present in quote" };
  }

  if (attribute === "services_offered" || attribute === "specialties") {
    for (const p of _RESELLER_PATTERNS) {
      if (normQ.includes(p)) {
        return {
          ok: false,
          reason:
            `quote contains reseller/partner pattern ${JSON.stringify(p)} — ` +
            "likely third-party products, not own services",
        };
      }
    }
    if (companyName) {
      const normCo = companyName.trim().toLowerCase();
      if (normV === normCo || (normV.length > 4 && normCo.includes(normV))) {
        return { ok: false, reason: "value equals company name" };
      }
    }
    return valueTokensInQuote(value, quote)
      ? { ok: true, reason: "" }
      : { ok: false, reason: "value tokens not supported by quote" };
  }

  if (attribute === "technology_stack") {
    // EXEMPT from reseller-pattern check — third-party tools ARE the stack.
    return valueTokensInQuote(value, quote)
      ? { ok: true, reason: "" }
      : { ok: false, reason: "tech stack value tokens not supported by quote" };
  }

  if (attribute === "employee_count_range") {
    if (!_HEADCOUNT_CONTEXT.some((c) => normQ.includes(c))) {
      return {
        ok: false,
        reason: "headcount quote lacks employee/staff/team context word",
      };
    }
    const nums = normV.match(/\d+/g) || [];
    if (nums.length && !nums.some((n) => normQ.includes(n))) {
      return { ok: false, reason: "headcount number not present in quote" };
    }
    return { ok: true, reason: "" };
  }

  if (attribute === "cage_code") {
    const clean = normV.replace(/\s/g, "").toUpperCase();
    if (!_CAGE_RE.test(clean)) {
      return {
        ok: false,
        reason: `value ${JSON.stringify(value)} does not match CAGE format (5 alphanumeric)`,
      };
    }
    if (!normQ.replace(/\s/g, "").includes(clean.toLowerCase())) {
      return { ok: false, reason: "CAGE code not present in quote" };
    }
    return { ok: true, reason: "" };
  }

  if (attribute === "uei") {
    const clean = normV.replace(/\s/g, "").toUpperCase();
    if (!_UEI_RE.test(clean)) {
      return {
        ok: false,
        reason: `value ${JSON.stringify(value)} does not match UEI format (12 alphanumeric)`,
      };
    }
    if (!normQ.replace(/\s/g, "").includes(clean.toLowerCase())) {
      return { ok: false, reason: "UEI not present in quote" };
    }
    return { ok: true, reason: "" };
  }

  if (attribute === "naics_codes") {
    const codes = normV.match(/\b\d{6}\b/g) || [];
    if (codes.length === 0) {
      return { ok: false, reason: "NAICS value contains no 6-digit code" };
    }
    if (!codes.some((c) => normQ.includes(c))) {
      return { ok: false, reason: "no NAICS code present in quote" };
    }
    return { ok: true, reason: "" };
  }

  if (attribute === "operational_throughput") {
    const nums = normQ.match(/\d[\d,]*/g) || [];
    if (nums.length === 0) {
      return { ok: false, reason: "throughput quote contains no number" };
    }
    if (!_THROUGHPUT_UNITS.some((u) => normQ.includes(u))) {
      return {
        ok: false,
        reason:
          "throughput quote lacks a unit word (scans/sites/projects/sq ft/...)",
      };
    }
    return { ok: true, reason: "" };
  }

  if (attribute === "notable_clients") {
    if (_PERSONAL_HISTORY.some((m) => normQ.includes(m))) {
      return {
        ok: false,
        reason:
          "quote describes personal employment history " +
          "(founder of / previously at / ex-), not a client relationship",
      };
    }
    return valueTokensInQuote(value, quote)
      ? { ok: true, reason: "" }
      : { ok: false, reason: "notable_clients value not in quote" };
  }

  // Generic rule for the rest (office_locations, mission_statement, etc.):
  // value tokens must mostly appear in the quote.
  return valueTokensInQuote(value, quote)
    ? { ok: true, reason: "" }
    : { ok: false, reason: "value tokens not supported by quote" };
}

// ----------------------------------------------------------------------
// Leadership-change validator (person name must appear in quote)
// ----------------------------------------------------------------------

export function validateLeadership(
  person: string,
  role: string,
  quote: string,
): ValidationResult {
  if (!person) return { ok: false, reason: "person field empty" };
  const normQ = normalize(quote);
  const normP = normalize(person);
  if (normQ.includes(normP)) return { ok: true, reason: "" };

  const tokens = normP.split(/\s+/).filter((t) => t.length > 2);
  const firstName = tokens[0];
  if (!firstName) {
    return { ok: false, reason: "person field has no usable tokens" };
  }

  // Whole-word match — avoid "dan" matching inside "danger".
  const wholeWord = new RegExp(
    `\\b${firstName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
  );
  if (wholeWord.test(normQ)) return { ok: true, reason: "" };

  // Nickname/full-name prefix match: Daniel <-> Dan, Christopher <-> Chris.
  for (const t of normQ.match(/\b\w+\b/g) || []) {
    if (
      t.length >= 3 &&
      (firstName.startsWith(t) || t.startsWith(firstName))
    ) {
      return { ok: true, reason: "" };
    }
  }
  return {
    ok: false,
    reason: `first name ${JSON.stringify(firstName)} not present in quote`,
  };
}

// ----------------------------------------------------------------------
// Source relevance gate (drop sources that are not actually about the
// prospect — catches same-name impostors like CT Brantley vs SC Brantley)
// ----------------------------------------------------------------------

const _CORP_SUFFIX = new RegExp(
  "\\b(company|companies|inc|incorporated|llc|llp|corporation|" +
    "corp|ltd|limited|holdings|group|co|plc)\\b\\.?",
  "gi",
);

function normalizePhrase(s: string): string {
  return s.replace(_CORP_SUFFIX, "").replace(_WS, " ").trim().toLowerCase()
    .replace(/[,.!?\-:;]+$/, "");
}

export interface RelevanceOptions {
  domain?: string;
  disambiguators?: string[];
  trustedUrls?: string[];
}

export interface RelevanceResult {
  ok: boolean;
  reason: string;
}

/**
 * Is this source actually about the prospect company? Returns
 * { ok: false, reason } if not — explained reasons are surfaced as
 * gap entries in the rendered brief.
 *
 * Decision tree (mirrors the Python implementation):
 *   1. No source text → drop
 *   2. URL exact-matches a trustedUrl → keep
 *   3. URL is a LinkedIn /in/ personal profile → keep only if company
 *      phrase is in text (no company-level inference allowed; that's
 *      enforced downstream)
 *   4. Domain provided AND in URL or text → keep
 *   5. Company phrase appears → require ≥1 disambiguator to pass
 *      (otherwise likely same-name impostor)
 *   6. Otherwise → drop
 */
export function isSourceAboutCompany(
  source: { id: string; url: string; snippet: string; title?: string },
  company: string,
  opts: RelevanceOptions = {},
): RelevanceResult {
  const text = normalize(source.snippet + " " + (source.title || ""));
  if (!text) return { ok: false, reason: "no source text" };

  const url = (source.url || "").toLowerCase();
  const trusted = new Set(
    (opts.trustedUrls || []).map((u) => u.toLowerCase().replace(/\/$/, "")),
  );
  if (trusted.has(url.replace(/\/$/, ""))) return { ok: true, reason: "" };

  // LinkedIn /in/ personal profiles are exempt from disambiguator gate,
  // but still must mention the company phrase.
  const isPersonalLi = url.includes("linkedin.com/in/");
  const nameCore = normalizePhrase(company);

  if (isPersonalLi) {
    return nameCore.includes(" ") && text.includes(nameCore)
      ? { ok: true, reason: "" }
      : { ok: false, reason: "LinkedIn profile without company phrase" };
  }

  if (opts.domain) {
    const d = opts.domain.toLowerCase().replace(/^www\./, "");
    if (url.includes(d) || text.includes(d)) return { ok: true, reason: "" };
  }

  const disambig = (opts.disambiguators || []).map((s) => s.toLowerCase());
  const phrasePresent =
    (nameCore.includes(" ") && text.includes(nameCore)) ||
    (text.includes(nameCore) && nameCore.length > 6);

  if (phrasePresent) {
    if (disambig.length > 0) {
      const anyHit = disambig.some((d) => text.includes(d) || url.includes(d));
      if (!anyHit) {
        return {
          ok: false,
          reason:
            "phrase match without any disambiguator — likely same-name impostor",
        };
      }
    }
    return { ok: true, reason: "" };
  }

  return {
    ok: false,
    reason: `company phrase ${JSON.stringify(nameCore)} not present in source`,
  };
}

// ----------------------------------------------------------------------
// DraftBrief-level pass: substring-check every claim's verbatim quote
// against the cited sources
// ----------------------------------------------------------------------

export interface VerifyClaimsStripped {
  location: string;
  claimText: string;
  reason: string;
}

export interface VerifyClaimsResult {
  /** Number of claims checked across the entire brief. */
  checked: number;
  /** Number of claims that passed substring + value validation. */
  passed: number;
  /** Claims that were dropped, with reasons. */
  stripped: VerifyClaimsStripped[];
}

type Risk = z.infer<typeof RiskSchema>;

/**
 * Walk the DraftBrief and verify every claim that has a verbatim quote
 * field against the source pack. Currently this covers:
 *   - DraftBrief.potentialRedFlags (BriefItems — no built-in quote field
 *     in TS schema, so we only verify they cite real source IDs)
 *   - Risks array (has evidenceQuote — full substring check)
 *
 * Returns a report; the orchestrator decides whether to strip or warn.
 * Pure function; does not mutate inputs.
 */
export function verifyBriefAgainstSources(
  brief: DraftBrief,
  risks: Risk[],
  pack: SourcePack,
): VerifyClaimsResult {
  const stripped: VerifyClaimsStripped[] = [];
  let checked = 0;

  const sourceById = new Map<string, (typeof pack.sources)[number]>();
  for (const s of pack.sources) sourceById.set(s.id, s);

  // Verify risks — they have explicit evidenceQuote.
  risks.forEach((r, i) => {
    checked++;
    let matchedIn: string | null = null;
    for (const sid of r.supportingSourceIds) {
      const src = sourceById.get(sid);
      if (!src) continue;
      if (quoteAppearsInSource(r.evidenceQuote, src.snippet)) {
        matchedIn = sid;
        break;
      }
    }
    if (!matchedIn) {
      stripped.push({
        location: `risks[${i}]`,
        claimText: r.summary,
        reason: `evidenceQuote not found in any cited source (${r.supportingSourceIds.join(", ")})`,
      });
    }
  });

  // Verify every BriefItem has at least one valid supporting source id.
  // When the item carries an `evidenceQuote`, also substring-check it
  // against the cited sources' snippets (same rule as Risks). Items
  // without an evidenceQuote get the lighter id-existence check —
  // graceful degradation, but lower trust.
  const sections: Array<
    [string, Array<{ text: string; supportingSourceIds: string[]; evidenceQuote?: string }>]
  > = [
    ["icebreakers", brief.icebreakers],
    ["valueAlignmentHooks", brief.valueAlignmentHooks],
    ["potentialRedFlags", brief.potentialRedFlags],
    ["talkingPoints", brief.talkingPoints],
    ["prepNotes", brief.prepNotes || []],
  ];
  for (const [section, items] of sections) {
    items.forEach((item, i) => {
      checked++;
      const validIds = item.supportingSourceIds.filter((id) => sourceById.has(id));
      if (validIds.length === 0) {
        stripped.push({
          location: `${section}[${i}]`,
          claimText: item.text.slice(0, 80),
          reason: `none of the supportingSourceIds (${item.supportingSourceIds.join(", ")}) exist in the SourcePack`,
        });
        return;
      }
      if (item.evidenceQuote && item.evidenceQuote.length > 0) {
        const matched = validIds.some((id) => {
          const src = sourceById.get(id);
          return src ? quoteAppearsInSource(item.evidenceQuote!, src.snippet) : false;
        });
        if (!matched) {
          stripped.push({
            location: `${section}[${i}]`,
            claimText: item.text.slice(0, 80),
            reason: `evidenceQuote not found in any cited source (${validIds.join(", ")})`,
          });
        }
      }
    });
  }

  return {
    checked,
    passed: checked - stripped.length,
    stripped,
  };
}
