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
  SnapshotItem,
  Source,
  SourcePack,
  VerifiedBrief,
} from "../types.js";

export interface RenderedBrief {
  markdown: string;
}

export function renderBrief(
  lead: Lead,
  verified: VerifiedBrief,
  sourcePack: SourcePack,
): RenderedBrief {
  const { brief } = verified;
  const referencedIds = collectReferencedIds(verified);
  const sources = sourcePack.sources.filter((s) => referencedIds.has(s.id));

  const md = [
    `# Discovery Prep — ${lead.company}`,
    lead.meetingAt
      ? `_Meeting: ${formatMeeting(lead.meetingAt)} — AE: ${lead.aeName}_`
      : `_AE: ${lead.aeName}_`,
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

  return { markdown: md };
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
