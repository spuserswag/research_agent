/**
 * Render a VerifiedBrief into Markdown for the profile folder.
 *
 * Layout (top to bottom):
 *   1. Header (company, meeting, AE)
 *   2. TL;DR           — 2-min version for the AE in a rush
 *   3. Call Objective  — one sentence north star
 *   4. Icebreakers
 *   5. Value Alignment Hooks
 *   6. Potential Red Flags
 *   7. Talking Points
 *   8. Attendee Intel
 *   9. Objection Predictions
 *  10. Sources
 *
 * Source IDs get inline footnote-style references like [src-3].
 * The Sources section maps IDs → URLs with title and date.
 */

import type {
  AttendeeIntel,
  BriefItem,
  GovContract,
  Lead,
  PublishedBrief,
  Risks,
  SnapshotItem,
  Source,
  SourcePack,
  VerifiedBrief,
} from "../types.js";

export interface RenderedBrief {
  markdown: string;
  /** PublishedBrief JSON — the canonical machine-readable contract.
   *  Written to brief.json alongside brief.md.  */
  published: PublishedBrief;
}

/**
 * Compile (Lead + VerifiedBrief + Risks + SourcePack) into a single
 * frontend-friendly `PublishedBrief`. Pure data transformation —
 * no LLM, no I/O.
 *
 * The orchestrator calls this and persists the result to brief.json.
 * The conference-copilot (and any future SDK client) consumes that file.
 */
export function compileBrief(
  lead: Lead,
  verified: VerifiedBrief,
  risks: Risks | undefined,
  sourcePack: SourcePack,
): PublishedBrief {
  const { brief, notes, passedVerification } = verified;
  const stripped = notes.filter((n) => n.status === "removed").length;

  // Count BriefItems across sections — used for signalQuality bucket.
  const totalClaims =
    (brief.executiveSnapshot?.length ?? 0) +
    brief.icebreakers.length +
    brief.valueAlignmentHooks.length +
    brief.talkingPoints.length +
    brief.potentialRedFlags.length +
    (brief.prepNotes?.length ?? 0);

  const sourceCount = sourcePack.sources.length;

  let signalQuality: PublishedBrief["meta"]["signalQuality"];
  if (sourceCount < 5 || totalClaims < 5) signalQuality = "low";
  else if (stripped >= 3 || stripped / Math.max(totalClaims, 1) >= 0.3)
    signalQuality = "thin";
  else if (sourceCount < 10 || totalClaims < 10) signalQuality = "moderate";
  else signalQuality = "rich";

  // Compute the same banner string the markdown renderer uses, so
  // frontend clients have it without re-implementing the rule.
  let confidenceBanner: string | undefined;
  if (sourceCount < 5 || totalClaims < 5) {
    confidenceBanner =
      `LOW-CONFIDENCE BRIEF: only ${sourceCount} source(s) and ` +
      `${totalClaims} claim(s) surfaced. Treat everything below as ` +
      `exploratory; the open questions are the main deliverable.`;
  } else if (stripped >= 3 || stripped / Math.max(totalClaims, 1) >= 0.3) {
    confidenceBanner =
      `LIMITED CONFIDENCE: ${stripped} of ${totalClaims} claims failed ` +
      `deterministic fact-verification and were removed. Corroborate ` +
      `key claims in the meeting before relying on them.`;
  }

  const referencedIds = collectReferencedIds(verified);
  const sources = sourcePack.sources.filter((s) => referencedIds.has(s.id));

  return {
    meta: {
      schemaVersion: 1,
      company: lead.company,
      ae: lead.aeName,
      meetingDate: lead.meetingAt,
      generatedAt: new Date().toISOString(),
      runId: lead.runId ?? "",
      audience: lead.audience,
      signalQuality,
      passedVerification,
      confidenceBanner,
    },
    executiveSnapshot: brief.executiveSnapshot ?? [],
    tldr: brief.tldr,
    callObjective: brief.callObjective,
    icebreakers: brief.icebreakers,
    valueAlignmentHooks: brief.valueAlignmentHooks,
    talkingPoints: brief.talkingPoints,
    potentialRedFlags: brief.potentialRedFlags,
    attendeeIntel: brief.attendeeIntel,
    objectionPredictions: brief.objectionPredictions,
    govContracts: brief.govContracts ?? [],
    prepNotes: brief.prepNotes ?? [],
    risks: risks?.risks ?? [],
    verifier: {
      notes,
      stripped,
      checked: totalClaims,
    },
    sources,
  };
}

export function renderBrief(
  lead: Lead,
  verified: VerifiedBrief,
  sourcePack: SourcePack,
  risks?: Risks,
): RenderedBrief {
  const { brief } = verified;
  const referencedIds = collectReferencedIds(verified);
  const sources = sourcePack.sources.filter((s) => referencedIds.has(s.id));

  const md = [
    `# Discovery Prep — ${lead.company}`,
    lead.meetingAt
      ? `_Meeting: ${formatMeeting(lead.meetingAt)} — AE: ${lead.aeName}_`
      : `_AE: ${lead.aeName}_`,
    confidenceBanner(verified, sourcePack),
    "",
    executiveSnapshotSection(brief.executiveSnapshot ?? []),
    tldrSection(brief.tldr),
    callObjectiveSection(brief.callObjective),
    labeledSection("Icebreakers", brief.icebreakers),
    labeledSection("Value Alignment Hooks", brief.valueAlignmentHooks),
    section("Potential Red Flags", brief.potentialRedFlags),
    numberedSection("Talking Points", brief.talkingPoints),
    attendeeIntelSection(brief.attendeeIntel),
    objectionsSection(brief.objectionPredictions),
    govContractsSection(brief.govContracts ?? []),
    prepNotesSection(brief.prepNotes ?? []),
    sourcesSection(sources),
    verified.passedVerification
      ? ""
      : "> ⚠️ This brief did not fully pass automated fact verification — review carefully before the call.",
  ]
    .filter((s) => s !== "")
    .join("\n\n");

  return {
    markdown: md,
    published: compileBrief(lead, verified, risks, sourcePack),
  };
}

// ---------- Confidence banner (ported from Python prospect_brief) ----------

/**
 * Render a prominent LIMITED-CONFIDENCE / LOW-CONFIDENCE banner when the
 * SourcePack is thin or the deterministic verifier stripped a meaningful
 * fraction of claims. Distinct from the existing verification-failure
 * banner — this one warns the AE *before* they read the brief that the
 * underlying evidence is shallow.
 */
function confidenceBanner(verified: VerifiedBrief, pack: SourcePack): string {
  const sourceCount = pack.sources.length;
  const stripped = verified.notes.filter((n) => n.status === "removed").length;

  // Count BriefItems across all sections (rough proxy for total claims).
  const b = verified.brief;
  const totalClaims =
    (b.executiveSnapshot?.length ?? 0) +
    b.icebreakers.length +
    b.valueAlignmentHooks.length +
    b.talkingPoints.length +
    b.potentialRedFlags.length +
    (b.prepNotes?.length ?? 0);

  if (sourceCount < 5 || totalClaims < 5) {
    return (
      `> ⚠️ **LOW-CONFIDENCE BRIEF**: only ${sourceCount} source(s) and ` +
      `${totalClaims} claim(s) surfaced. Treat everything below as ` +
      `exploratory; the open questions are the main deliverable.`
    );
  }
  if (stripped >= 3 || stripped / Math.max(totalClaims, 1) >= 0.3) {
    return (
      `> ⚠️ **LIMITED CONFIDENCE**: ${stripped} of ${totalClaims} claims ` +
      `failed deterministic fact-verification and were removed. The brief ` +
      `is useful as a primer, but corroborate key claims in the meeting ` +
      `before relying on them.`
    );
  }
  return ""; // healthy brief — no banner
}

// ---------- Section renderers ----------

function executiveSnapshotSection(items: SnapshotItem[]): string {
  if (!items.length) return "";
  const bullets = items
    .map((it) => `- **${it.label}:** ${it.text}${refs(it.supportingSourceIds)}`)
    .join("\n");
  return `## 📊 Executive Snapshot\n\n${bullets}`;
}

function tldrSection(items: string[]): string {
  if (!items.length) return "";
  const bullets = items.map((t) => `- ${t}`).join("\n");
  return `## TL;DR\n\n${bullets}`;
}

function callObjectiveSection(objective: string): string {
  if (!objective) return "";
  return `## Call Objective\n\n> ${objective}`;
}

function section(title: string, items: BriefItem[]): string {
  if (!items.length) return `## ${title}\n\n_None._`;
  const bullets = items
    .map((it) => `- ${it.text}${refs(it.supportingSourceIds)}`)
    .join("\n");
  return `## ${title}\n\n${bullets}`;
}

/** Like section() but renders label bold before text when present. */
function labeledSection(title: string, items: BriefItem[]): string {
  if (!items.length) return `## ${title}\n\n_None._`;
  const bullets = items
    .map((it) => {
      const prefix = it.label ? `**${it.label}:** ` : "";
      return `- ${prefix}${it.text}${refs(it.supportingSourceIds)}`;
    })
    .join("\n");
  return `## ${title}\n\n${bullets}`;
}

/** Like labeledSection() but numbered 1. 2. 3. instead of bullets. */
function numberedSection(title: string, items: BriefItem[]): string {
  if (!items.length) return `## ${title}\n\n_None._`;
  const lines = items
    .map((it, i) => {
      const prefix = it.label ? `**${it.label}:** ` : "";
      return `${i + 1}. ${prefix}${it.text}${refs(it.supportingSourceIds)}`;
    })
    .join("\n");
  return `## ${title}\n\n${lines}`;
}

function attendeeIntelSection(attendees: AttendeeIntel[]): string {
  if (!attendees.length) return "";
  const rows = attendees
    .map(
      (a) =>
        `- **${a.name}** (${a.title}) — ${a.note}${refs(a.supportingSourceIds)}`,
    )
    .join("\n");
  return `## Attendee Intel\n\n${rows}`;
}

function objectionsSection(
  objections: VerifiedBrief["brief"]["objectionPredictions"],
): string {
  if (!objections.length) return "";
  const items = objections
    .map(
      (o) =>
        `- **They might say:** ${o.objection}\n  **You can respond:** ${o.suggestedResponse}${refs(o.supportingSourceIds)}`,
    )
    .join("\n");
  return `## Objection Predictions\n\n${items}`;
}

function govContractsSection(contracts: GovContract[]): string {
  if (!contracts.length) return "";
  const header = `| Agency | Project | Value | Awarded |`;
  const divider = `|--------|---------|-------|---------|`;
  const rows = contracts.map((c) => {
    const agency = c.agency.replace(/\|/g, "\\|");
    const desc = c.description.replace(/\|/g, "\\|");
    const value = (c.value ?? "—").replace(/\|/g, "\\|");
    const date = c.awardedAt ?? "—";
    const citation = c.supportingSourceIds.length ? " " + c.supportingSourceIds.map((id) => `[${id}]`).join(" ") : "";
    return `| ${agency} | ${desc}${citation} | ${value} | ${date} |`;
  });
  return `## Government Contract Awards\n\n${[header, divider, ...rows].join("\n")}`;
}

function prepNotesSection(items: BriefItem[]): string {
  if (!items.length) return "";
  const bullets = items
    .map((it) => `- ${it.text}${refs(it.supportingSourceIds)}`)
    .join("\n");
  return `## AEC Prep Notes\n\n${bullets}`;
}

function sourcesSection(sources: Source[]): string {
  if (!sources.length) return "";
  const lines = sources
    .map(
      (s) =>
        `- **${s.id}** [${s.title}](${s.url})${s.publishedAt ? ` — ${s.publishedAt}` : ""}`,
    )
    .join("\n");
  return `## Sources\n\n${lines}`;
}

// ---------- Helpers ----------

function refs(ids: string[]): string {
  if (!ids.length) return "";
  return " " + ids.map((id) => `[${id}]`).join(" ");
}

function collectReferencedIds(verified: VerifiedBrief): Set<string> {
  const ids = new Set<string>();
  const { brief } = verified;
  for (const item of (brief.executiveSnapshot ?? [])) {
    item.supportingSourceIds.forEach((id) => ids.add(id));
  }
  for (const item of [
    ...brief.icebreakers,
    ...brief.valueAlignmentHooks,
    ...brief.potentialRedFlags,
    ...brief.talkingPoints,
  ]) {
    item.supportingSourceIds.forEach((id) => ids.add(id));
  }
  for (const a of brief.attendeeIntel) {
    a.supportingSourceIds.forEach((id) => ids.add(id));
  }
  for (const o of brief.objectionPredictions) {
    o.supportingSourceIds.forEach((id) => ids.add(id));
  }
  for (const c of (brief.govContracts ?? [])) {
    c.supportingSourceIds.forEach((id) => ids.add(id));
  }
  for (const p of (brief.prepNotes ?? [])) {
    p.supportingSourceIds.forEach((id) => ids.add(id));
  }
  return ids;
}

function formatMeeting(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
