# Arvaya Discovery Prep Agent

A multi-agent orchestrator that produces a pre-call brief for Arvaya account executives before every prospect discovery session. Ships with an iPad-optimized viewer and HTTP/SSE server so Ryan can read briefs and kick off new ones from a tablet.

## iPad viewer (the fastest way in)

```bash
cp .env.example .env                 # OPENAI_API_KEY + PERPLEXITY_API_KEY + FIRECRAWL_API_KEY
npm install
npm run serve                        # boots the server on http://localhost:5174
```

Open `http://<your-laptop-ip>:5174` on the iPad (same Wi-Fi as the server). The viewer:

- **Lists every brief** under `./profiles/` in the left sidebar, filterable by company.
- **Renders the full PublishedBrief** as a CTO-friendly dashboard: executive snapshot cards, latest-news cards, role-tagged buying committee, attendee intel, icebreakers + hooks + talking points, risk audit, objection prep, sources. Dark mode by default; light mode kicks in when the iPad is set to light.
- **Kicks off new briefs** with a "＋ New brief" button — fill in company / website / prospect / meeting time / recency / objective, hit generate, and the orchestrator's stage progress streams over Server-Sent Events so Ryan watches the brief assemble in real time (~1–3 minutes).

A demo brief for **Northwind Logistics** ships under `./profiles/northwind-logistics/` — open the viewer immediately to see what a populated brief looks like even before you've configured any API keys.

### Pipeline view (added 2026-05-15)

The sidebar shows every company in `./leads/` grouped by meeting date — **Today**, **This week**, **Upcoming**, **Unscheduled**, **Past**. Companies that already have a brief render normally; companies still in the pipeline (no brief yet) surface a "Generate brief" CTA in the detail panel that prefills from the lead's hand-tuned context (archetype, hypothesis, exclude keywords, competitors). The refresh button on an existing brief regenerates from the same lead stub.

`npm run seed:leads` seeds `./leads/*.json` from `companies.csv` — 40 AECTech 2026 exhibitors with sensible defaults and disambiguation hints for collision-prone names (Box, Mosaic, IES, Kinship, Nomic). Hand-tuned leads (egnyte, joist-ai, seev, Larson-Design-Group) are never clobbered.

### Design choices baked into the viewer

- **Funding strip in the header** — headcount, total funding, last round, founded year, industry. Parsed from the Apollo source's JSON snippet, surfaced before everything else because that's what a CTO scans first.
- **Tech stack as chips** — pulled from the same Apollo source, so it's visible without reading prose.
- **Trust marker (`✓`) on claims** — items with a `evidenceQuote` that passed the deterministic verifier get a small green check. Items without (lighter check) still cite a source ID but weren't substring-matched.
- **Tap-to-copy** on icebreakers and talking points — Ryan can paste straight into Slack or a calendar invite.
- **Hash routing** — every brief has a stable URL (e.g. `#brief:egnyte/2026-05-13T16-36-11-783Z/brief.json`). Bookmarkable on the iPad home screen; back/forward gestures work.
- **Skeleton loaders** while a brief loads — no flash of empty state.
- **Live SSE progress in the modal** when a new brief is being generated; sidebar row badges flip to "generating…" with a pulse animation so Ryan can tell at a glance.

### HTTP API (single-tenant, no auth — see `docs/roadmap.md` Phase 4A)

| Method | Path | What it does |
|---|---|---|
| `GET`  | `/` | Serves `viewer/index.html`. |
| `GET`  | `/api/briefs` | Lists every brief in `profilesDir`, newest first. |
| `GET`  | `/api/briefs/<slug>/<runId>/brief.json` | Returns one `PublishedBrief`. |
| `POST` | `/api/briefs` | Accepts a `Lead`, starts the pipeline in-process, returns `{ runId }` immediately. |
| `GET`  | `/api/briefs/<runId>/events` | SSE stream: `stage_started`, `stage_finished`, `done`, `failed`. |

## What it does

You hand the system a prospect (company, AE, meeting time) as JSON. The system:

1. **Discovers** the prospect's digital footprint via Perplexity Sonar deep research — real-time news, exec interviews, job postings, financials, and buying-committee intelligence
2. **Extracts** deep content from high-value URLs via Firecrawl — full interview transcripts, earnings call pages, engineering blog posts
3. **Extracts** strategic initiatives and pain points from the gathered sources
4. **Detects** risk signals — layoffs, budget freezes, leadership churn, security incidents, legal issues
5. **Writes** a personalized brief: **TL;DR**, **Call Objective**, **Icebreakers**, **Value Alignment Hooks**, **Potential Red Flags**, **Talking Points**, **Attendee Intel**, **Objection Predictions**
6. **Verifies** every claim against captured source snippets (recency, deduplication, specifics checks)
7. **Writes** the brief and all supporting research into a **company profile folder** on disk

## Architecture

Five specialized OpenAI agents pipelined by a thin TypeScript orchestrator. Each agent is a single `chat.completions.create` call to `gpt-4o` via the official `openai` SDK with its own system prompt, tools, and strictly typed JSON output. The orchestrator owns the data plane — it threads outputs from one agent into the next and persists everything to a per-prospect profile folder.

> **SDK choice.** We use the OpenAI Chat Completions API directly. The Researcher's tool calls are dispatched locally; OpenAI does not offer a server-side `web_search` tool, so all retrieval is done through Perplexity (`sonar-pro` for breadth, `sonar-deep-research` for depth) and Firecrawl. The downstream four agents are tool-free: closed-book reasoning over what the Researcher captured.

```
                  ┌────────────────────────────────────────────────────────────┐
                  │                     Orchestrator (Node)                    │
                  └────────────────────────────────────────────────────────────┘
                                              │
   ┌──────────────────────────────────────────┼─────────────────────────────────────┐
   │                                          │                                     │
   ▼                                          ▼                                     ▼
Lead JSON                               Five-agent pipeline                 ./profiles/<slug>/<runId>/
(file or CLI flags)                       (OpenAI SDK)                       brief.md + research/*.json
                                              │
   ┌────────────┬─────────────────────────────┼──────────────────────┬────────────────────┐
   ▼            ▼                             ▼                      ▼                    ▼
Researcher   SignalExtractor           RiskDetector        PersonalizationWriter      QAVerifier
                                              │
                          ┌───────────────────┼─────────────────────────────────┐
                          ▼                   ▼                                 ▼
                  perplexity_search    perplexity_discovery              firecrawl_scrape
                   (custom tool)         (custom tool)                    (custom tool)
                  Perplexity sonar-pro  Perplexity sonar-deep-research      Firecrawl
   │             │                          │                      │                         │
   ▼             ▼                          ▼                      ▼                         ▼
SourcePack    Signals                   Risks                 DraftBrief                VerifiedBrief
                                                                                            │
                                                                                            ▼
                                                                                   Profile folder on disk
```

### Why pipeline, not a single ReAct loop

A pipeline gives us:

- **Deterministic separation of concerns.** The Researcher only fetches; the Verifier only checks.
- **Independent prompt tuning.** Risk detection and personalization are different muscles; we iterate on them separately.
- **Cheap, parallel-safe verification.** The QA agent sees only the draft and cached source snippets — no tools, no re-querying — so it cannot hallucinate a fix.
- **Structured handoffs.** Each stage emits typed JSON, which we persist. Reproducible, debuggable, and easy to swap any one agent later.

### Agent contracts

| Agent | Input | Tools | Output |
|---|---|---|---|
| Researcher | `Lead` | `perplexity_search`, `perplexity_discovery`, `firecrawl_scrape` | `SourcePack` |
| SignalExtractor | `SourcePack` | none | `Signals` |
| RiskDetector | `SourcePack` | none | `Risks` |
| PersonalizationWriter | `Lead`, `SourcePack`, `Signals`, `Risks` | none | `DraftBrief` |
| QAVerifier | `DraftBrief`, `SourcePack` | none | `VerifiedBrief` |

Citations use opaque `sourceId`s assigned by the Researcher (e.g. `src-3`). Every downstream claim must cite at least one. The Verifier rejects any claim whose snippet does not actually support it.

### Tool stack

| Tool | Layer | Why |
|---|---|---|
| **Perplexity `perplexity_search`** | Breadth scan (cheap) | `sonar-pro` does fast, ~$0.01/call landscape mapping. The Researcher runs this first to decide which angles have enough signal to warrant a deep-research call. |
| **Perplexity `perplexity_discovery`** | Targeted deep research | `sonar-deep-research` does multi-step web reasoning to find specific interviews, job postings, news, financials, and people. ~$0.05–$0.10/call, 60–120s per call. Capped at 2–3 calls per run, only on angles confirmed by the breadth scan. |
| **Firecrawl `firecrawl_scrape`** | Full-page extraction | Used sparingly on high-value URLs where the Perplexity snippet is too thin to support a defensible claim — exec interview transcripts, earnings call pages, engineering blog posts. Capped at 5 fetches per run. |

### Brief sections

| Section | Purpose |
|---|---|
| **TL;DR** | 1–3 bullets for the AE who has 2 minutes, not 10 |
| **Call Objective** | One-sentence north star: the single most important thing to learn |
| **Icebreakers** | Specific, time-bound openers tied to concrete sources; ordered by recency |
| **Value Alignment Hooks** | Connects Arvaya's wedge to each major initiative; frameable against `productFocus` |
| **Potential Red Flags** | Risk signals the AE needs to know going in |
| **Talking Points** | Open-ended pain-discovery questions, each source-backed |
| **Attendee Intel** | Buying committee and likely call participants beyond the primary prospect |
| **Objection Predictions** | Context-specific objections with suggested responses |
| **Sources** | Full citation list with URLs and dates |

### Cost envelope (per prep run, rough)

- OpenAI gpt-4o (5 agents): $0.15–$0.40
- Perplexity (1–2 `sonar-pro` breadth + 2–3 `sonar-deep-research` deep): ~$0.15–$0.40
- Firecrawl: ~$0.005 × ≤5 fetches = ~$0.025

Total: roughly **$0.30–$0.80 per prospect brief**.

## Output: the company profile folder

Every successful run writes a single self-contained folder:

```
profiles/
└── northwind-logistics/
    └── 2026-05-07T20-15-22-117Z/
        ├── brief.md                    # ← the deliverable, read this first
        ├── run.json                    # lead, timing, status (includes the Lead you provided)
        └── research/
            ├── sources.json            # Researcher output: SourcePack
            ├── signals.json            # SignalExtractor output
            ├── risks.json              # RiskDetector output
            ├── draft-brief.json        # PersonalizationWriter output
            └── verified-brief.json     # QAVerifier output (final, pruned)
```

Multiple runs for the same prospect over time stack neatly under the company slug. The CLI prints the profile folder path and brief path on success.

## How you run it

Provide the lead as JSON. Two ways:

**Lead file (recommended):**

```bash
cp leads/_template.json leads/<company-slug>.json
# edit leads/<company-slug>.json — replace every <...> placeholder
npm run prep -- --lead leads/<company-slug>.json
```

`leads/_template.json` is the canonical scaffold. Sensible defaults are pre-filled (AE name, AE email, productFocus, archetype, meetingType); per-prospect fields carry `<...>` placeholders that double as inline guidance. `samples/exampleLead.json` is a fully-populated worked example you can compare against.

Three pre-built validation leads also live in `leads/` — `egnyte.json`, `joist-ai.json`, `seev.json`. They span the failure modes (rich footprint, severe name-collision, thin footprint) and are the recommended sanity check after any change to the Researcher prompt.

**Inline flags:**

```bash
npm run prep -- \
  --company "Northwind Logistics" \
  --website https://northwindlogistics.com \
  --ae-name "Jordan" \
  --ae-email jordan@arvayaconsulting.com \
  --prospect-name "Pat Lee" \
  --prospect-title "VP Data" \
  --meeting-at 2026-05-12T15:00:00Z \
  --product-focus "RAG implementation" \
  --deal-stage warm \
  --prospect-archetype other \
  --meeting-type first_intro \
  --intro-source cold_outbound \
  --call-objective "Confirm whether the Q3 self-service analytics launch is funded." \
  --hypothesis "Their data org is fragmented; they need orchestration before models." \
  --exclude-keywords "northwind database,sql server example" \
  --competitive-context "Slalom,Snowflake Professional Services"
```

> The bare `--` before your flags tells npm to pass everything to the script. Flags with multiple values (`--exclude-keywords`, `--competitive-context`) accept comma-separated strings.

Lead JSON shape — every field except `company`, `aeName`, and `aeEmail` is optional. Open `leads/_template.json` for the full annotated scaffold; here is the abbreviated map:

```jsonc
{
  // --- Required ---
  "company": "Northwind Logistics",
  "aeName": "Jordan",
  "aeEmail": "jordan@arvayaconsulting.com",

  // --- Basics (optional, recommended) ---
  "website": "https://northwindlogistics.com",
  "prospectName": "Pat Lee",
  "prospectTitle": "VP Data",
  "meetingAt": "2026-05-12T15:00:00Z",
  "productFocus": "RAG implementation",
  "dealStage": "cold | warm | evaluation",
  "prospectArchetype": "aec_firm | aec_vendor | other",
  "excludeKeywords": ["disambiguation", "hints"],

  // --- Goal / context (optional, big lift on quality) ---
  "callObjective": "...",
  "hypothesis": "...",
  "meetingContext": "...",
  "meetingType": "first_intro | discovery | proposal_review | renewal | partnership_explore",
  "engagementShape": "...",
  "introSource": "inbound | referral | event | cold_outbound | reactivation",
  "introContext": "...",
  "competitiveContext": ["competitor 1", "competitor 2"]
}
```

**Required fields:** `company`, `aeName`, `aeEmail`.

**Optional but high-impact (basics):** `prospectTitle` (drives title calibration in the brief), `productFocus` (sharpens value alignment hooks), `dealStage` (tunes objection framing), `prospectArchetype` (one of `aec_firm`, `aec_vendor`, `other` — switches the Researcher's tool plan; see below), `excludeKeywords` (string array — disambiguation hints; sources whose URL/title/snippet contain any of these are dropped).

**Optional goal/context fields (substantially improve brief quality when populated):**

| Field | What it does |
|---|---|
| `callObjective` | What Arvaya wants out of THIS specific meeting. The Writer uses it verbatim instead of synthesizing one. One sentence is enough. |
| `hypothesis` | Arvaya's prior on the prospect's biggest pain. The Researcher tests it (validate or contradict via a dedicated breadth-scan call); the Writer leads with it if confirmed and soft-pivots if disconfirmed. |
| `meetingContext` | Free-form narrative of how the meeting came about — referral, event, inbound, etc. Used to set tone but never quoted directly in the brief. |
| `meetingType` | One of `first_intro`, `discovery`, `proposal_review`, `renewal`, `partnership_explore`. Adjusts the brief shape — first_intro is exploratory; proposal_review is objection-heavy; renewal is retention-framed. |
| `engagementShape` | What Arvaya is selling on this call. Free-form, e.g. `"fixed-scope discovery sprint"`, `"advisory retainer"`, `"implementation engagement"`. AT LEAST ONE Value Alignment Hook must reference it directly when set. |
| `introSource` | One of `inbound`, `referral`, `event`, `cold_outbound`, `reactivation`. Picks icebreaker register. |
| `introContext` | Free-form qualifier on `introSource`, e.g. `"Met at AECTech booth"` or `"Referred by Pat Lee at Northwind"`. |
| `competitiveContext` | String array of likely competing vendors. Every named competitor must appear in at least one Objection Prediction. |

The big three fields with the largest measurable impact on brief quality are `callObjective`, `hypothesis`, and `meetingContext`. Populate those before worrying about the rest.

### Choosing `prospectArchetype`

| Value | When | What changes |
|---|---|---|
| `aec_firm` | General contractors, design firms, owner-operators — companies that build things or run AEC projects | Researcher runs SAM.gov / USASpending / IDIQ / task-order queries plus a Procore / Autodesk / Bluebeam / Viewpoint stack scan |
| `aec_vendor` | Software, SaaS, or services vendors selling INTO AEC | Researcher runs vendor-shape queries: AEC customer case studies, ML/data-engineering hiring, GitHub presence, funding history; SKIPS the gov-contract/project-stack queries |
| `other` (default) | Everything else | General-purpose flow with no archetype-specific calls |

### When to use `excludeKeywords`

Use whenever the company name collides with a bigger or different entity. Without it, the Researcher silently pulls wrong-company sources. Example values:

- For `Box` (the cloud-content company): `["box office", "cardboard", "boxing"]`
- For `Joist AI`: `["Joist app", "consumer contractor", "homeowner"]`
- For `Brantley Construction Company`: `["Brantley County wildfire", "Brantley County, GA"]`

## File layout

```
Crawler2/
├── package.json
├── tsconfig.json
├── .env.example
├── README.md
├── companies.csv                     # Target-account list (40 AEC vendors)
├── arvaya-lead.json                  # Self-test lead (Arvaya researching itself)
├── docs/
│   ├── architecture.svg              # Visual schematic
│   ├── build-summary.md              # Decisions log + file inventory
│   └── audit-2026-05-08.md           # Crawler audit + tier-by-tier company plan
├── leads/                            # ← Per-prospect lead JSONs go here
│   ├── _template.json                # Annotated scaffold — copy this for new leads
│   ├── egnyte.json                   # Validation lead — Tier A (rich footprint)
│   ├── joist-ai.json                 # Validation lead — Tier B (name-collision)
│   └── seev.json                     # Validation lead — Tier C (thin footprint)
├── src/
│   ├── index.ts                      # CLI: reads lead.json or flags
│   ├── server.ts                     # HTTP + SSE server (npm run serve)         ← NEW 2026-05-15
│   ├── config.ts                     # Env loader + validation
│   ├── types.ts                      # Lead, SourcePack, Signals, Risks, Brief, ...
│   ├── orchestrator.ts               # Pipelines the 5 agents; emits structured progress events
│   ├── agents/
│   │   ├── researcher.ts
│   │   ├── signalExtractor.ts
│   │   ├── riskDetector.ts
│   │   ├── personalizationWriter.ts
│   │   └── qaVerifier.ts
│   ├── prompts/
│   │   ├── researcher.md             # Phase -1 disambiguation, archetype branching, soft minimum
│   │   ├── signalExtractor.md
│   │   ├── riskDetector.md
│   │   ├── personalizationWriter.md  # Reads goal/context fields off Lead + latestNews/buyingCommittee rules
│   │   └── qaVerifier.md
│   ├── tools/
│   │   ├── apollo.ts                 # Firmographics + people search (Phase 0)
│   │   ├── perplexity.ts             # perplexity_search (sonar-pro) + perplexity_discovery (sonar-deep-research)
│   │   ├── firecrawl.ts              # URL → clean markdown
│   │   └── email.ts                  # Resend wrapper (opt-in: lead.deliverByEmail)
│   └── lib/
│       ├── agentClient.ts            # Shared runAgent — wraps OpenAI Chat Completions + tool loop
│       ├── briefRenderer.ts          # VerifiedBrief → markdown + PublishedBrief JSON
│       ├── verify.ts                 # Deterministic substring/quote verification
│       ├── jsonExtract.ts            # Robust JSON extraction from agent output
│       ├── costLedger.ts             # Per-tool cost telemetry
│       └── logger.ts                 # JSON logger
├── viewer/
│   └── index.html                    # Single-file iPad-optimised viewer       ← NEW 2026-05-15
├── samples/
│   ├── exampleLead.json              # Worked example — fully populated current-schema lead
│   └── exampleBrief.md               # Reference brief output for prompt tuning
└── profiles/                         # ← generated; one folder per prospect run
```

## Running

Two entry points share the same orchestrator:

**CLI** — one-shot per lead, writes to disk:

```bash
cp .env.example .env                              # OPENAI_API_KEY + PERPLEXITY_API_KEY + FIRECRAWL_API_KEY (+ optional APOLLO_API_KEY)
npm install
cp leads/_template.json leads/my-lead.json        # edit per-prospect fields
npm run prep -- --lead leads/my-lead.json         # generates brief.md + brief.json
```

**HTTP server + iPad viewer** — multi-brief UI for Ryan:

```bash
npm run serve                                     # http://localhost:5174
```

Then open the URL on the iPad. Generate new briefs from the "＋ New brief" button; the SSE progress stream lights up each stage as the orchestrator runs.

`npm test` runs the 65 hermetic tests (no API keys needed). `npm run typecheck` runs the TS compiler in noEmit mode.

## What changed 2026-05-15

This pass landed Phase 1F (schema additions) and the bulk of Phase 2B (frontend integration) from `docs/roadmap.md`:

- `latestNews` and `buyingCommittee` are first-class schema sections.
- `BriefItem.evidenceQuote` is verified by the deterministic pre-pass (was Risks-only before).
- `Lead.recency` and `SourcePack.freshness` flow end-to-end.
- `DraftBrief` minimum-count floors softened so the Writer can degrade gracefully on thin-footprint companies.
- Orchestrator progress events flow through a typed `EventEmitter` consumed by both the CLI spinner and the SSE endpoint.
- `src/server.ts` + `viewer/index.html` ship the iPad-friendly UI end-to-end with a demo brief pre-populated under `./profiles/northwind-logistics/`.
