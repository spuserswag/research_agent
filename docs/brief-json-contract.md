# `brief.json` — published brief JSON contract

The orchestrator writes `brief.json` next to `brief.md` in every profile run folder. This file is the **canonical machine-readable contract** for downstream clients — the conference-copilot frontend, future SDK clients, any third-party integration that wants to consume a brief programmatically.

Schema source of truth: `src/types.ts` → `PublishedBriefSchema`. Validated with Zod.

## Compatibility & versioning

`meta.schemaVersion: 1` is the current version. Rules of the road for changes:

- **Adding optional fields is non-breaking** — clients should ignore unknown fields gracefully. Don't bump the schema version.
- **Removing or renaming fields, or changing field types, is breaking** — bump `meta.schemaVersion` and document a migration path.
- **Tightening an existing field** (e.g., adding a new enum value) is non-breaking for emitters but breaking for strict consumers. Treat case-by-case.

## Top-level shape

```ts
{
  meta: {
    schemaVersion: 1,
    company: string,
    ticker?: string,
    ae: string,
    meetingDate?: string,           // ISO 8601 if known
    generatedAt: string,            // ISO 8601 of compile time
    runId: string,
    audience?: "ceo" | "cto" | "cfo" | "coo" | "cro" | "generic",
    signalQuality: "rich" | "moderate" | "thin" | "low",
    passedVerification: boolean,
    confidenceBanner?: string,
  },

  executiveSnapshot: SnapshotItem[],
  tldr: string[],
  callObjective: string,
  icebreakers: BriefItem[],
  valueAlignmentHooks: BriefItem[],
  talkingPoints: BriefItem[],
  potentialRedFlags: BriefItem[],
  attendeeIntel: AttendeeIntel[],
  objectionPredictions: {
    objection: string,
    suggestedResponse: string,
    supportingSourceIds: string[],
  }[],
  govContracts: GovContract[],
  prepNotes: BriefItem[],

  risks: Risk[],

  verifier: {
    notes: VerificationNote[],
    stripped: number,
    checked: number,
  },

  sources: Source[],     // only sources actually cited somewhere in the brief
}
```

`BriefItem`, `SnapshotItem`, `AttendeeIntel`, `GovContract`, `Risk`, `Source`, `VerificationNote` are all defined in `src/types.ts` — see Zod schemas there for exact field types.

## Signal quality buckets (for triage UIs)

`meta.signalQuality` is a coarse summary the frontend can use to drive list-view triage (badge color, sort order, "needs review" flag):

- **`rich`** — ≥10 sources, ≥10 claims, low strip rate. Safe to lead with the brief.
- **`moderate`** — partial coverage. Brief is useful as a primer; expect to drive 30-50% of the call through discovery.
- **`thin`** — passed all gates but the strip rate ≥30% OR the verifier removed ≥3 claims. Treat as exploratory.
- **`low`** — < 5 sources OR < 5 claims survived. The "What we couldn't find" / discovery questions are the main deliverable.

The renderer also computes a human-readable `meta.confidenceBanner` string when quality is thin or low; the frontend can surface this verbatim above the brief.

## Reading citations

Every section that contains BriefItems has a `supportingSourceIds: string[]` field per item. To resolve a citation:

1. Look up the ID in the top-level `sources` array (`sources.find(s => s.id === ref)`).
2. The matched `Source` has `{ id, url, title, publishedAt?, category, snippet }`.
3. `snippet` is the verbatim excerpt the agent used to ground that claim — surface it in the UI on hover or in a "Why this?" expander.

The deterministic verifier (`src/lib/verify.ts`) guarantees that every `supportingSourceIds` entry in a published brief actually exists in `sources`. Claims whose IDs didn't resolve were stripped before this file was written; you'll see them in `verifier.notes` with `status: "removed"`.

## Filesystem layout (where to find a brief.json)

```
profiles/
  <companySlug>/
    <runId>/
      brief.md            <- human-readable markdown
      brief.json          <- the canonical PublishedBrief JSON (this doc)
      run.json            <- full pipeline record (cost, usage, lead, etc.)
      research/
        verified-brief.json   <- intermediate (before render)
        source-pack.json
        ...
```

`runId` is filesystem-safe ISO timestamp by default. The frontend should cache by `(companySlug, runId)` and surface "Generate fresh brief" to trigger a new run.

## Example minimal consumer (TypeScript)

```ts
import { readFile } from "node:fs/promises";
import { PublishedBriefSchema } from "./src/types.js";

const raw = JSON.parse(await readFile("brief.json", "utf8"));
const brief = PublishedBriefSchema.parse(raw);

console.log(brief.meta.company, brief.meta.signalQuality);
for (const item of brief.icebreakers) {
  console.log("•", item.text, "→", item.supportingSourceIds);
}
```

If you're a frontend dev consuming this from an API endpoint, just `axios.get('/api/briefs/:runId')` and parse with the same schema. Source of truth always wins; never duplicate the type definitions in the frontend codebase.
