# Build Summary — Arvaya Discovery Prep Agent

A point-in-time record of every decision, change, and current-state fact for the discovery prep agent project. Use this to spot inconsistencies before we keep building.

**As of:** May 8, 2026
**TypeScript build:** clean (`tsc --noEmit` exits 0)
**Project root:** `~/Desktop/Crawler2/`

---

## 1. What we're building

A multi-agent orchestrator that, given a prospect (company + AE + meeting time as JSON), produces a discovery-call prep brief and writes it (plus all supporting research) into a company profile folder on disk. The brief contains: Icebreakers, Value Alignment Hooks, Potential Red Flags, Talking Points, Objection Predictions. Every claim is grounded in a captured source snippet and verified before the brief is finalized.

---

## 2. Decision log (chronological)

Each row is a decision made in conversation, what changed in the code, and where to verify it.

| # | Decision | Reason | Where it shows up |
|---|---|---|---|
| 1 | TypeScript / Node, not Python | User chose TS | `package.json`, `tsconfig.json` |
| 2 | Pipeline of 5 agents (not single ReAct loop) | Deterministic; cheap parallel-safe verification; structured handoffs | `src/orchestrator.ts`, all `src/agents/*` |
| 3 | Each agent emits typed JSON validated by Zod | No agent consumes another's free-form prose | `src/types.ts` schemas; each agent calls `Schema.parse(extractJson(text))` |
| 4 | Originally: Perplexity Sonar as the research tool | Easiest path to grounded answers w/ citations | **INTERIM** — briefly replaced by web_search + Apollo + Firecrawl (decision #5), then reverted back to Perplexity + Firecrawl (decision #16) |
| 5 | Interim: switched research stack to Anthropic web_search + Apollo + Firecrawl | Better data quality; native to Anthropic; structured firmographics from Apollo; Firecrawl for full-page fetches | **SUPERSEDED by #16** — web_search removed (OpenAI has no equivalent), Apollo replaced by Perplexity |
| 6 | Originally: Monday.com webhook trigger | Auto-fire when status flips | **REMOVED** per user request |
| 7 | Manual JSON lead input via CLI | User will provide leads themselves | `src/index.ts`, `samples/exampleLead.json`, README "How you run it" |
| 8 | `Lead.itemId` → `Lead.runId` (optional, auto-generated) | itemId was Monday-specific; runId is a generic on-disk run identifier | `src/types.ts` LeadSchema, RunRecord; `src/orchestrator.ts` `buildRunId()` |
| 9 | Switched from `@anthropic-ai/claude-agent-sdk` to raw `@anthropic-ai/sdk` | Agent SDK is for autonomous ReAct agents; we need a deterministic JSON pipeline | `package.json` deps, `src/lib/claudeClient.ts`, README §"SDK choice" callout |
| 10 | Default model `claude-sonnet-4-6` (Opus toggle on PersonalizationWriter) | Sonnet quality is sufficient; Opus is a one-line switch if briefs feel flat | **SUPERSEDED by #15** — current default is `gpt-4o` for all five agents. |
| 11 | Originally: Resend for email delivery | Simple modern transactional API | **REMOVED** — replaced by company profile folder output |
| 12 | Output is a self-contained company profile folder, not email | AE wants the documentation alongside the brief; one folder per prospect, multiple runs stack neatly under company slug | `src/orchestrator.ts` (folder layout), `src/lib/briefRenderer.ts` (markdown only, HTML dropped), README §"Output: the company profile folder" |
| 13 | Project location: `~/Desktop/Crawler2/` | User staged it on Desktop. (Folder renamed from `Crawler/` to `Crawler2/` during the OpenAI/Perplexity rebuild — see #15.) | `docs/build-summary.md` header |
| 14 | Documented commands use `npm`, not `pnpm` | User preference | README, build-summary, `src/index.ts` docstring |
| 15 | Switched LLM from Anthropic Claude (`@anthropic-ai/sdk`) to OpenAI gpt-4o (`openai`) | Cost / availability tradeoffs after switching the discovery layer to Perplexity. Also caused `web_search` (an Anthropic-only server-tool) to be removed from the Researcher's tool set. | `src/lib/claudeClient.ts` (now wraps the OpenAI SDK; types kept identical for source-level compatibility), `src/config.ts` (requires `OPENAI_API_KEY`, no longer `ANTHROPIC_API_KEY`), `.env.example`, `package.json` deps |
| 16 | Apollo replaced by Perplexity as the discovery layer | Apollo's static firmographics under-deliver on real-time intent (recent news, exec interviews, hiring activity); `sonar-deep-research` does multi-step web reasoning that surfaces those signals. | `src/tools/perplexity.ts` (two tools: `perplexity_search` for breadth on `sonar-pro`, `perplexity_discovery` for depth on `sonar-deep-research`), `src/agents/researcher.ts`, `src/prompts/researcher.md`. `src/tools/apollo.ts` retained as a deprecated stub that throws on use — safe to delete. |
| 17 | Added `prospectArchetype` and `excludeKeywords` to `LeadSchema` | Prevented two recurring failure modes: (a) the AEC-firm-only SAM.gov / Procore-stack queries firing on AEC software vendors and wasting deep-research credits, and (b) name-collision sources (e.g. Brantley County wildfire on Brantley Construction Company) silently being included. | `src/types.ts` (new optional fields), `src/index.ts` (CLI flags `--prospect-archetype` and `--exclude-keywords`), `src/prompts/researcher.md` (new Phase -1 disambiguation block + archetype branching) |
| 18 | Researcher source-count minimum softened for thin-footprint targets | The 8-source minimum was failing on small private companies (Arvaya self-test returned 2 sources). New rule: if breadth scans return <10 citations or disambiguation prunes heavily, the floor drops to 4 and the Researcher emits a `src-meta-thin` meta source. The QAVerifier knows about this signal and softens minimum-section counts when present. | `src/prompts/researcher.md` (Quality rules section), `src/prompts/qaVerifier.md` (thin-footprint exception in pruning rules) |
| 19 | Added 8 goal/context fields to LeadSchema | Brantley brief came back generic ("how are you gearing up for this growth phase?") because the lead JSON described who the prospect was but never said why Arvaya was in the room. New fields tell each agent what the meeting is FOR: `callObjective` (used verbatim by Writer), `hypothesis` (Researcher tests; Writer leads-with or pivots), `meetingContext` (tone), `meetingType` (brief shape), `engagementShape` (sharpens valueAlignmentHooks), `introSource` + `introContext` (icebreaker register), `competitiveContext` (every named competitor must appear in an Objection Prediction). All optional. | `src/types.ts` (LeadSchema), `src/index.ts` (CLI flags), `src/prompts/personalizationWriter.md` (extensive new section + per-section rules), `src/prompts/researcher.md` (hypothesis-test call + competitor-angle call), `src/prompts/qaVerifier.md` (allow empty supportingSourceIds on competitor-driven objectionPredictions). |
| 20 | Added `evidenceQuote` and `auditorReasoning` (required) to RiskSchema | Brantley risks.json came back as `{"risks": []}` despite a 22,420-acre wildfire in Brantley County (operating region) and a single-named-contact signal in the SourcePack. Diagnosis: the Risk Detector defaults to "calibrated, conservative — empty is correct" and has no chain-of-thought scaffolding. Smallest experiment: force every risk to carry a verbatim evidence snippet and a one-paragraph auditor justification. If briefs still come back empty after this, the bottleneck is the prompt taxonomy (point #1 in the May 8 risk-detector critique), not the schema. | `src/types.ts` (RiskSchema), `src/prompts/riskDetector.md` (rules + output spec). Pessimistic Auditor frame, archetype-branched taxonomy, adversarial Perplexity queries, and two-tier SourcePack are NOT shipped — held pending evaluation of this experiment. |

---

## 3. Architecture (current)

### 3.1 Pipeline

```
Lead JSON (manual)
   │
   ▼
Orchestrator (Node)
   │
   ▼
[1] Researcher ──► [2] SignalExtractor ─┐
                                         ├─► [4] PersonalizationWriter ──► [5] QAVerifier ──► Profile folder on disk
                  └─► [3] RiskDetector ──┘                                                     (./profiles/<slug>/<runId>/)
```

Stages 2 and 3 run in parallel via `Promise.all` (both consume only the SourcePack).

### 3.2 Agent contracts

| # | Agent | Input | Tools | Output |
|---|---|---|---|---|
| 1 | Researcher | `Lead` | `perplexity_search`, `perplexity_discovery`, `firecrawl_scrape` | `SourcePack` |
| 2 | SignalExtractor | `SourcePack` | none | `Signals` |
| 3 | RiskDetector | `SourcePack` | none | `Risks` |
| 4 | PersonalizationWriter | `Lead`, `SourcePack`, `Signals`, `Risks` | none | `DraftBrief` |
| 5 | QAVerifier | `DraftBrief`, `SourcePack` | none | `VerifiedBrief` |

The Researcher is the only agent with tools and the only one that touches the network. Everything downstream is closed-book reasoning over what the Researcher captured.

### 3.3 Tool stack

| Tool | Layer | Type | Notes |
|---|---|---|---|
| `perplexity_search` | Breadth scan | Custom | `sonar-pro`, ~$0.01/call. Mandatory first call; landscape map across news / jobs / execs / financials. Used to decide which angles deserve a deep-research call. |
| `perplexity_discovery` | Targeted deep research | Custom | `sonar-deep-research`, ~$0.05–$0.10/call, 60–120s per call. Capped at 2–3/run; only on angles confirmed by the breadth scan. |
| `firecrawl_scrape` | Full-page fetch | Custom | Used sparingly (≤5/run) on high-value URLs (interviews, earnings, long posts). |

OpenAI does not offer a server-side `web_search` tool, so all retrieval is via the three custom tools above.

---

## 4. Data contracts (Zod schemas in `src/types.ts`)

### Lead (input)

```ts
{
  runId?: string;                 // auto-generated if omitted
  company: string;                // REQUIRED
  website?: string;               // URL
  prospectName?: string;
  prospectTitle?: string;
  aeName: string;                 // REQUIRED
  aeEmail: string;                // REQUIRED, validated as email — kept for record-keeping in run.json
  meetingAt?: string;             // ISO 8601
  productFocus?: string;
  dealStage?: "cold" | "warm" | "evaluation";
  prospectArchetype?: "aec_firm" | "aec_vendor" | "other";   // switches Researcher tool plan
  excludeKeywords?: string[];                                 // disambiguation hints

  // Goal / context (decision #19) — all optional. Big lift on brief quality when populated.
  callObjective?: string;                  // what THIS meeting is for; Writer uses verbatim
  hypothesis?: string;                     // Arvaya's prior on prospect pain
  meetingContext?: string;                 // narrative free-text
  meetingType?: "first_intro" | "discovery" | "proposal_review" | "renewal" | "partnership_explore";
  engagementShape?: string;                // what Arvaya is selling
  introSource?: "inbound" | "referral" | "event" | "cold_outbound" | "reactivation";
  introContext?: string;                   // free-form qualifier on introSource
  competitiveContext?: string[];           // every named competitor must appear in an Objection Prediction
}
```

### SourcePack (Researcher output)

```ts
{
  lead: Lead;
  generatedAt: string;            // ISO 8601, attached by orchestrator
  sources: Source[];              // max 40
}

Source = {
  id: string;                     // "src-1", "src-2", ...
  url: string;
  title: string;
  publishedAt?: string;
  category: "news" | "exec_interview" | "job_posting" | "filing" | "funding" | "product" | "social" | "other";
  snippet: string;                // verbatim, ≤ 600 chars
}
```

### Signals (SignalExtractor output)

```ts
{
  signals: Array<{
    kind: "initiative" | "pain" | "tech_stack" | "growth_indicator" | "competitive_pressure" | "regulatory_change";
    summary: string;
    detail: string;
    supportingSourceIds: string[];   // min 1
  }>
}
```

### Risks (RiskDetector output)

```ts
{
  risks: Array<{
    category: "layoffs" | "budget_freeze" | "leadership_churn" | "security_incident" | "legal_issue" | "other";
    severity: "low" | "medium" | "high";
    summary: string;
    detail: string;
    evidenceQuote: string;     // verbatim snippet from SourcePack that triggered this flag (decision #20)
    auditorReasoning: string;  // one-para chain-of-thought: why this severity, now, given market context (decision #20)
    supportingSourceIds: string[];   // min 1
  }>
}
```

### DraftBrief (PersonalizationWriter output)

```ts
{
  executiveSnapshot?:    SnapshotItem[];  // 3–5 data-point cards (scale, backlog, market context, margin pressure)
  tldr:                  string[];        // 1–3 bullets; the 2-minute version
  callObjective:         string;          // one sentence north star
  icebreakers:           BriefItem[];     // 2–5
  valueAlignmentHooks:   BriefItem[];     // 2–5
  potentialRedFlags:     BriefItem[];     // 0+
  talkingPoints:         BriefItem[];     // 3–8
  attendeeIntel:         AttendeeIntel[]; // max 4 — buying committee beyond the primary prospect
  objectionPredictions:  Array<{
    objection: string;
    suggestedResponse: string;
    supportingSourceIds: string[];
  }>;                                     // max 5
  govContracts?:         GovContract[];   // public-sector awards; empty if none found
  prepNotes?:            BriefItem[];     // AEC/industry-specific prep notes; empty if not applicable
}

BriefItem    = { label?: string; text: string; supportingSourceIds: string[]; }
SnapshotItem = { label: string; text: string; supportingSourceIds: string[]; }
AttendeeIntel = { name: string; title: string; note: string; supportingSourceIds: string[]; }
GovContract   = { agency: string; description: string; value?: string; awardedAt?: string; supportingSourceIds: string[]; }
```

### VerifiedBrief (QAVerifier output)

```ts
{
  brief: DraftBrief;                    // pruned: unsupported items removed; same shape as DraftBrief above
  notes: Array<{
    location: string;                   // e.g. "icebreakers[1]"
    status: "confirmed" | "weak" | "removed";
    reason: string;
  }>;
  passedVerification: boolean;          // false if any required section dropped below its minimum count
}
```

### Citation invariant

Every BriefItem and ObjectionPrediction carries `supportingSourceIds`. The QAVerifier removes any item whose snippets do not actually support its claim. Source IDs are opaque (`src-N`) and assigned by the Researcher.

---

## 5. File inventory (current state)

All paths relative to `~/Desktop/Crawler2/`. Line counts approximate.

### Top-level

| File | Purpose |
|---|---|
| `README.md` | Project overview, architecture, run instructions |
| `package.json` | Deps + scripts |
| `tsconfig.json` | Strict TS config; ESM + Bundler resolution |
| `.env.example` | Required env vars (4 keys + optional `PROFILES_DIR`) |
| `.gitignore` | `node_modules`, `dist`, `.env`, `profiles/`, log files |

### Code

| File | Purpose |
|---|---|
| `src/index.ts` | CLI entry. Parses `--lead path` or inline flags, validates with `LeadSchema`, calls `runOrchestrator`, prints profile path on success. |
| `src/config.ts` | Env loader + validation. Throws if any required env var is missing. |
| `src/types.ts` | All Zod schemas + TS types. Single source of truth for the data plane. |
| `src/orchestrator.ts` | Pipelines the 5 agents. Writes `./profiles/<companySlug>/<runId>/`. Auto-generates `runId` if not provided. |

### Agents

| File | Purpose |
|---|---|
| `src/agents/researcher.ts` | Calls `runAgent` with three custom tools (`perplexity_search`, `perplexity_discovery`, `firecrawl_scrape`). Budget: 16k tokens, 12 iterations. |
| `src/agents/signalExtractor.ts` | Tool-free `runAgent`. Budget: 6k tokens. |
| `src/agents/riskDetector.ts` | Tool-free `runAgent`. Budget: 4k tokens. |
| `src/agents/personalizationWriter.ts` | Tool-free `runAgent`. Budget: 8k tokens. |
| `src/agents/qaVerifier.ts` | Tool-free `runAgent`. Budget: 10k tokens. |

### Prompts (system prompts read from disk at runtime)

| File | Purpose |
|---|---|
| `src/prompts/researcher.md` | Phase -1 disambiguation (anchor block + excludeKeywords filter), then breadth → deep → extract → synthesise. Branches on `prospectArchetype` (aec_firm / aec_vendor / other). Soft-minimum source rule via `src-meta-thin`. Tests `lead.hypothesis` and `lead.competitiveContext` when present. |
| `src/prompts/signalExtractor.md` | Defines the six signal kinds (initiative, pain, tech_stack, growth_indicator, competitive_pressure, regulatory_change). |
| `src/prompts/riskDetector.md` | Risk categories + severity rubric. Empty output is allowed for clean prospects. |
| `src/prompts/personalizationWriter.md` | Section-by-section brief structure. Bakes in Arvaya's wedge. Reads the goal/context fields off Lead — `callObjective` (used verbatim), `hypothesis` (lead-with-or-pivot), `engagementShape`, `meetingType`, `introSource`/`introContext`, `competitiveContext` (every named competitor must surface in an Objection Prediction). |
| `src/prompts/qaVerifier.md` | Verifier rules: existence, support, specifics check, pruning, minimum-count enforcement. Knows about `src-meta-thin` (softens minimums) and competitor-driven Objection Predictions (allows empty supportingSourceIds). |

### Tools

| File | Purpose |
|---|---|
| `src/tools/perplexity.ts` | Two custom tools — `perplexity_search` (sonar-pro, breadth, ~$0.01/call) and `perplexity_discovery` (sonar-deep-research, depth, ~$0.05–$0.10/call, 60–120s/call). Both record cost telemetry into the cost ledger. |
| `src/tools/firecrawl.ts` | One custom tool (`firecrawl_scrape`) using `@mendable/firecrawl-js`. Returns markdown by default; truncates to `maxChars`. |
| `src/tools/webSearch.ts` | **Deleted.** Was an inert stub (`export const webSearchToolConfig = null`). OpenAI has no server-side `web_search` equivalent; nothing imported it. |
| `src/tools/apollo.ts` | **Deleted.** Was a deprecated stub — both functions threw on call, nothing imported it. Replaced by `perplexity_discovery` (decision #16). |
| `src/tools/email.ts` | Inactive Resend wrapper. Wired up in `config.ts` for an old email-delivery path that's currently a no-op; no code path emits email. |

### Lib

| File | Purpose |
|---|---|
| `src/lib/agentClient.ts` | Shared `runAgent` helper — wraps the OpenAI Chat Completions API and runs the tool-use loop. Custom tools are dispatched locally with Zod input validation; tool errors propagate as `role: "tool"` messages with the error text. Caps at `maxIterations` and logs partial context before throwing. (Previously named `claudeClient.ts`; renamed May 2026 when the Anthropic → OpenAI migration was finalised.) |
| `src/lib/briefRenderer.ts` | Renders `VerifiedBrief` → markdown. Pulls referenced sources from the SourcePack. |
| `src/lib/jsonExtract.ts` | Robust JSON extraction from agent output. Handles ```code-fenced JSON, leading prose, and balanced-brace scanning. |
| `src/lib/costLedger.ts` | Per-tool cost telemetry written into `run.json` and surfaced in the CLI summary at the end of each run. |
| `src/lib/logger.ts` | Minimal structured JSON logger. |

### Docs / samples / leads

| File | Purpose |
|---|---|
| `docs/architecture.svg` | Visual schematic (hand-drawn — verify against §3.1 if it diverges). |
| `docs/build-summary.md` | This document. |
| `docs/audit-2026-05-08.md` | Crawler audit covering the 40-company target list — tiering, name-collision hazards, recommended prompt changes, validation plan. |
| `leads/_template.json` | Annotated scaffold for new leads. Pre-filled defaults + `<...>` placeholders. Copy this for every new prospect. |
| `leads/egnyte.json` | Validation lead — Tier A (rich footprint), `aec_vendor` archetype. |
| `leads/joist-ai.json` | Validation lead — Tier B (severe name collision against the consumer Joist app). |
| `leads/seev.json` | Validation lead — Tier C (thin footprint, generic name). |
| `samples/exampleLead.json` | Fully-populated worked example using all current fields. Compare against this when filling out the template. |
| `samples/exampleBrief.md` | Reference brief output for prompt tuning. |
| `companies.csv` | Target-account list — 40 AEC software vendors from an AECTech 2026 sponsor/exhibitor list. |
| `arvaya-lead.json` | Self-test lead pointing Arvaya at itself. |

### Files removed or emptied during the build

| File | Reason |
|---|---|
| `src/tools/monday.ts` | Removed per user request (decision #6) |
| `src/tools/apollo.ts` | Deleted — was a deprecated stub (decision #16, open question #7). Both exports threw on call; nothing imported it. |
| `src/tools/webSearch.ts` | Deleted — Anthropic-only server-tool; exported `null`; nothing imported it. OpenAI has no equivalent. |
| `src/tools/email.ts` | Logic removed in decision #12; the file remains as an inactive wrapper but no code path uses it. |
| `@anthropic-ai/sdk`, `@anthropic-ai/claude-agent-sdk` | Replaced by the `openai` SDK (decisions #9 and #15). |

---

## 6. Per-run output: the profile folder

```
profiles/
└── northwind-logistics/
    └── 2026-05-07T20-15-22-117Z/
        ├── brief.md                  # the deliverable; AE reads this
        ├── run.json                  # lead + timing + status (Lead is embedded here)
        └── research/
            ├── sources.json          # SourcePack (Researcher output)
            ├── signals.json          # SignalExtractor output
            ├── risks.json            # RiskDetector output
            ├── draft-brief.json      # PersonalizationWriter output
            └── verified-brief.json   # QAVerifier output (final, pruned)
```

- Top-level slug uses the company name (lowercased, non-alphanumeric collapsed to `-`).
- `runId` defaults to a filesystem-safe ISO timestamp; can be overridden via `lead.runId` or `--run-id` CLI flag.
- Multiple runs over time stack under the same company slug.
- The CLI prints the absolute paths of the profile folder and `brief.md` on success.

---

## 7. How to run it

```bash
cd ~/Desktop/Crawler2
cp .env.example .env                              # fill keys (see §8)
npm install
cp leads/_template.json leads/my-lead.json        # edit per-prospect fields
npm run prep -- --lead leads/my-lead.json
```

CLI also accepts inline flags as an alternative to the JSON file:

```bash
npm run prep -- \
  --company "Northwind Logistics" \
  --website https://northwindlogistics.com \
  --ae-name "Jordan" \
  --ae-email jordan@arvayaconsulting.com \
  --prospect-name "Pat Lee" \
  --prospect-title "VP Data" \
  --meeting-at 2026-05-12T15:00:00Z
```

> The bare `--` before flags tells npm to pass everything that follows to the script.

---

## 8. Required env vars

| Variable | Required? | Used by |
|---|---|---|
| `OPENAI_API_KEY` | yes | `runAgent` (all 5 stages — gpt-4o by default) |
| `PERPLEXITY_API_KEY` | yes | Researcher's `perplexity_search` + `perplexity_discovery` |
| `FIRECRAWL_API_KEY` | yes | Researcher's `firecrawl_scrape` |
| `PROFILES_DIR` | optional | Defaults to `./profiles` |
| `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO` | optional | Wired in `config.ts` for an old email-delivery path that's currently a no-op; safe to leave unset. |

No `ANTHROPIC_API_KEY`, `APOLLO_*`, `MONDAY_*`, or webhook-secret env vars are required.

---

## 9. Cost envelope (per prep run, rough)

- OpenAI gpt-4o (5 agents): **$0.15–$0.40**
- Perplexity (1–2 `sonar-pro` breadth + 2–3 `sonar-deep-research` deep): **$0.15–$0.40**
- Firecrawl: ~$0.005 × ≤5 fetches = **~$0.025**

**Total: ~$0.30–$0.80 per prospect brief.**

---

## 10. Dependency manifest

### Runtime

| Package | Version | Purpose |
|---|---|---|
| `openai` | latest | OpenAI Chat Completions API |
| `@mendable/firecrawl-js` | ^1.4.0 | Firecrawl scraper |
| `dotenv` | ^16.4.5 | Env loading |
| `zod` | ^3.23.8 | Runtime schema validation |
| `zod-to-json-schema` | ^3.23.0 | Convert Zod tool input schemas to JSON Schema for OpenAI tool definitions |

### Dev

`@types/node`, `resend` (inactive email path — kept in devDeps so `src/tools/email.ts` compiles), `tsx`, `typescript`, `vitest`.

### Removed during the build

- `@anthropic-ai/sdk` — replaced by `openai` (decision #15)
- `@anthropic-ai/claude-agent-sdk` — see decision #9
- `express`, `@types/express` — webhook server removed (decision #6)
- `resend` — email delivery removed (decision #12)

---

## 11. Open questions / TODOs

1. **Validation runs of the new archetype branching** — `prospectArchetype` and `excludeKeywords` shipped as prompt + schema changes only. Three pre-built leads sit in `leads/` (Egnyte, Joist AI, Seev) for the first end-to-end test. Run those first before touching the rest of the 40-company target list in `companies.csv`.
2. **Title focus per archetype** — the Researcher's `people` focus still defaults to a generic technical-buyer list (CIO, CTO, CISO, CDO, VP Data, VP Engineering, Head of AI, Chief AI Officer). For `aec_vendor` archetype, the right targets are usually founders, CEOs, Heads of Product, Heads of AI/ML — consider tightening this in the next prompt iteration.
3. **gpt-4o vs gpt-4 / o-series for the Writer** — currently all five agents use `gpt-4o`. Decide after seeing real briefs whether the PersonalizationWriter benefits from a stronger model.
4. **Profile retention** — every run persists to `./profiles/<slug>/<runId>/` indefinitely. Decide retention window before production.
5. **PII / compliance** — briefs include named individuals (executives). Confirm acceptable use for Arvaya's clients.
6. **LinkedIn coverage** — Perplexity surfaces LinkedIn URLs but the bodies are bot-blocked from Firecrawl. The People focus relies on whatever Perplexity synthesizes. If LinkedIn intent signal becomes important, layer in a paid LI-data source.
7. **`apollo.ts` cleanup** — file remains as a deprecated stub that throws. Safe to delete; left in only because nothing imports it anymore.

---

## 12. Consistency check (last run May 8, 2026)

```
monday refs:                                   (none)
itemId refs:                                   (none)
runs/ refs:                                    (none — replaced by profiles/)
express / webhook refs:                        (none)
@anthropic-ai/claude-agent-sdk refs in code:   only in explanatory comments
@anthropic-ai/sdk refs in code:                only in the "API mapping" docstring at the top of claudeClient.ts
apollo refs in code:                           src/tools/apollo.ts only (deprecated stub, throws on call); not imported by anything
resend / email refs:                           src/tools/email.ts and the optional Resend env vars in config.ts; no active code path uses them
prompt-time validation:                        researcher.md references prospectArchetype + excludeKeywords; types.ts schema matches
```

If you find an inconsistency I missed, the likely culprits are:

- A stale comment/docstring referencing the old design
- The SVG schematic (it's hand-drawn — visually verify it matches §3.1)
- The example brief in `samples/exampleBrief.md` (it's illustrative, not generated, so it doesn't have to match real output but should be consistent in shape)
