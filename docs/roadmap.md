# Crawler2 — End-to-end Roadmap

_Last updated: 2026-05-12_

This is the engineering plan from "where we are right now" to "we can sell this software." Each phase has concrete tasks, effort estimate, and dependency on prior phases. Phases that can run in parallel are marked.

Status legend: ✅ done · 🟡 in progress · ⬜ not started · ⛔ blocker

---

## Phase 0 — Where we are today (snapshot, 2026-05-12)

✅ TypeScript multi-agent backend in `src/` is functional. Researcher → SignalExtractor → RiskDetector → PersonalizationWriter → QAVerifier. Uses Perplexity (search) + Firecrawl (scraping) + Apollo (people data) + OpenAI.
✅ Python verifier-first pipeline in `prospect_brief/` is functional. Substring-quote-checked extraction. Produces brief.md + facts.json + sources.md per prospect.
✅ Conference-copilot frontend exists as a standalone Gemini-export React+Express+Prisma+SQLite app at `conference-copilot (1) (1)/`. NOT yet integrated with either backend.
✅ Deterministic verifier (`src/lib/verify.ts`) ported from Python into TS. 40 Vitest tests cover the historical failure cases. Wired into `qaVerifier.ts` as a deterministic pre-pass that runs before the LLM verifier.
✅ Three lead files exist for testing: `leads/egnyte.json`, `leads/joist-ai.json`, `leads/seev.json`.
✅ Two Python lead files exist: `prospect_brief/leads/quantum.json`, `prospect_brief/leads/brantley.json`.

---

## Phase 1 — Backend consolidation onto TypeScript

**Goal:** one backend the frontend can talk to. Retire the Python pipeline once parity is reached. Estimated **5-7 working days total** across this phase.

### 1A — Deterministic verifier port ✅ (DONE 2026-05-12)

- ✅ `src/lib/verify.ts` ported from Python `verify.py` + `relevance.py`
- ✅ 40 Vitest tests (`src/lib/verify.test.ts`) covering every historical failure case (CT Brantley impostor, QRC "Public Company", Asheville-as-HQ, DroneLeaf-as-client, Daniel/Dan nickname match, etc.)
- ✅ Wired into `src/agents/qaVerifier.ts` as a two-pass: deterministic first, LLM second
- ✅ Forced `passedVerification = false` if anything was stripped deterministically

### 1B — Content port from Python prompts to TS prompts ✅ (DONE 2026-05-12)

Pure-content work, no infrastructure change:

- ✅ Audience-aware question banks (CEO / CTO / CFO / COO / CRO / generic) ported into `src/prompts/personalizationWriter.md`
- ✅ Archetype taxonomy for weak risk signals (Capacity Crunch, Founder-Only Top Team, Single-Vendor Dependency, Quiet Period, etc.) ported into `src/prompts/riskDetector.md`
- ✅ Industry RPE benchmark table (13 sectors) added to PersonalizationWriter prompt
- ✅ Pessimistic news query (Call 5 — adversarial lawsuit/OSHA/safety query) added to `src/prompts/researcher.md`
- ✅ Confidence-warning banner ("LOW-CONFIDENCE" / "LIMITED CONFIDENCE") added to `src/lib/briefRenderer.ts`
- ✅ `audience` field added to `LeadSchema`
- ✅ Vitest run: 65/65 passing

### 1C / 1D — PublishedBriefSchema + compileBrief() ✅ (DONE 2026-05-12)

- ✅ `PublishedBriefSchema` defined in `src/types.ts` — canonical machine-readable contract with `meta.schemaVersion: 1`, signalQuality bucket, full section coverage, verifier metadata
- ✅ `compileBrief(lead, verified, risks, sourcePack) → PublishedBrief` in `src/lib/briefRenderer.ts`
- ✅ `renderBrief` now returns both `markdown` and `published`; orchestrator writes both `brief.md` and `brief.json` per run
- ✅ `docs/brief-json-contract.md` documents the schema for frontend devs

### 1E — Retire prospect_brief/ ✅ (DONE 2026-05-12, soft archive)

- ✅ `prospect_brief/` moved to `_archived/prospect_brief/` (git history preserved)
- ✅ Root-level Python artifacts (`apollo.py`, `apollo_output.{csv,json}`, `arvaya-lead.json`, `brantley-lead.json`) moved to `_archived/`
- ✅ `conference-copilot (1) (1)/` renamed to `conference-copilot/`
- ⬜ Single root `README.md` describing one backend + one frontend — **deferred to Phase 2**

---

## Phase 2 — Conference-copilot frontend integration

**Goal:** the frontend reads briefs from the backend instead of being a standalone tracker. Estimated **5-7 working days**, can start the moment Phase 1C lands.

### 2A — Schema expansion (1 day)

- ⬜ Add a `Brief` model to `conference-copilot/prisma/schema.prisma` with: `id`, `exhibitorId` (FK), `runId`, `status` ("queued" | "running" | "done" | "failed"), `briefJson` (Json), `generatedAt`, `verifierPassed` (boolean), `confidenceLevel` ("limited" | "moderate" | "rich" | null), `errorMessage`.
- ⬜ Add `prisma migrate dev` migration.
- ⬜ Update `Exhibitor` model to include a `latestBriefId` cache for fast list-view rendering.

### 2B — Backend API endpoints (1-2 days)

- ⬜ `POST /api/exhibitors/:id/brief` — kick off a brief generation run. Returns `runId`. Status starts as "queued".
- ⬜ `GET  /api/exhibitors/:id/brief` — return the current latest brief (or `null` + status if in-flight).
- ⬜ `GET  /api/briefs/:runId` — poll status of a specific run.
- ⬜ Backend job runner: when a brief is queued, write a temporary `leads/<id>.json`, shell out to `npm run prep -- --lead <path>`, capture stdout/stderr, parse `<profileFolder>/brief.json`, write to the `Brief` row, mark `status=done` (or `failed` with error).

### 2C — Frontend Brief Drawer (2 days)

- ⬜ Add a `<BriefDrawer />` component that opens when the user clicks an exhibitor row. Renders the `PublishedBrief` JSON shape into the same section layout we have today.
- ⬜ "Generate brief" button on the row (when `latestBrief` is null) and "Refresh" button (when one exists). Status indicator (queued / running spinner / failed).
- ⬜ **Confidence badge** in the drawer header — surfaces the verifier's LIMITED / MODERATE / RICH judgment so reps don't accidentally quote inferred content.
- ⬜ Inferred sections (the strategist's modeled revenue, value hooks, weak risk signals) get a distinct visual treatment from the verified-facts sections (different background, `[inferred]` tag). Must be visually impossible to confuse the two.

### 2D — Excel import + auto-enrichment (1 day)

- ⬜ When the user imports an `.xlsx` of exhibitors, optionally queue a brief generation for each new row (background job).
- ⬜ Bulk regenerate ("refresh all stale briefs for this conference").
- ⬜ Rate limit so a 200-row Excel import doesn't fan out to 200 simultaneous API calls.

### 2E — Replace Gemini-only dependency (½ day)

- ⬜ Remove `@google/genai` from `conference-copilot/package.json` — leftover from AI Studio export. We're consolidated on OpenAI/Perplexity.
- ⬜ Audit other Gemini-leftover code paths in App.tsx and server.ts.

---

## Phase 3 — Production hardening (parallel with Phase 2)

**Goal:** the backend is safe to point at real customer use. Estimated **3-5 working days**, runs alongside Phase 2.

### 3A — Validation runs (½ day)

- ⬜ Run `egnyte.json`, `joist-ai.json`, `seev.json` after Phase 1B prompt changes. Compare brief outputs vs. baseline. Document any quality regressions in `docs/regression-2026-MM-DD.md`.

### 3B — Existing carry-forward items from docs/checklist.md (2-3 days)

- ⬜ **Tighten `aec_vendor` Researcher title focus** — currently generic technical-buyer list; pin to founders, CEOs, Heads of Product/AI.
- ⬜ **Evaluate gpt-4o vs stronger model for PersonalizationWriter** after seeing real briefs. Decide on a model per agent.
- ⬜ **Profile retention policy** — `./profiles/` grows indefinitely. Decide TTL (probably 90 days) and add cleanup cron.
- ⬜ **LinkedIn coverage** — Firecrawl is bot-blocked. Pay for a real LI data source (Proxycurl, ScrapingDog, or similar) or accept the recall gap.
- ⬜ **Regenerate `samples/exampleBrief.md`** from a real run.
- ⬜ **Update `docs/architecture.svg`** to reflect the deterministic verifier pre-pass and the consolidated single-backend story.

### 3C — Observability (1-2 days)

- ⬜ Wire **Sentry** (or equivalent) for backend errors. Each brief run gets a span; failures get auto-reported.
- ⬜ **Structured logs** — every agent + tool emits JSON logs with `runId`, `tenantId` (when Phase 4 lands), `costUsd`, `latencyMs`.
- ⬜ **Cost dashboard** — extend `costLedger.ts` to write per-run cost summaries to a queryable table (initially SQLite, eventually Postgres).
- ⬜ **Run-failure alerting** — Slack/email webhook when a brief run fails or exceeds cost threshold.

### 3D — Caching parity (½ day)

- ⬜ The Python pipeline has a fetch-cache + extraction-cache with explicit version stamps. The TS backend has profile-level caching but no per-fetch cache. Either: (a) port the cache, or (b) decide we don't need it and document the cost implications.

---

## Phase 4 — Auth, multi-tenant, billing

**Goal:** the product is ready to onboard a paying customer. Estimated **6-9 working days**.

### 4A — Auth + workspaces (3-4 days)

- ⬜ Pick auth provider — recommendation: **Clerk** for speed (Stripe-style hosted UI, free up to 10K MAU).
- ⬜ Add `User` + `Workspace` Prisma models. Every existing model (Conference, Exhibitor, Contact, Brief) gets a `workspaceId` FK.
- ⬜ Row-level access control middleware on every API route.
- ⬜ Workspace switcher in the frontend.
- ⬜ Invite flow: workspace owner can invite teammates.
- ⬜ API key management for programmatic access (per-workspace).

### 4B — Billing (2-3 days)

- ⬜ **Stripe** integration with subscription tiers. Initial plan: Free (5 briefs/mo), Pro ($X/seat/mo, 200 briefs/mo), Enterprise (custom).
- ⬜ Per-workspace usage tracking — extend cost ledger to be tenant-aware.
- ⬜ Hard quota enforcement: API returns 402 when over plan.
- ⬜ Invoicing + receipts via Stripe Billing Portal.
- ⬜ Trial flow: 14-day free trial of Pro tier.

### 4C — Telemetry per tenant (1 day)

- ⬜ Per-tenant cost tracking — which workspace ran what, and how much it cost in OpenAI/Perplexity/Firecrawl/Apollo.
- ⬜ Admin dashboard showing tenant usage + margin.
- ⬜ Per-tenant rate limits (avoid one tenant burning the shared API budget).

### 4D — Audit log (½ day)

- ⬜ Append-only audit log of every brief generated, by whom, for what company. Required for any enterprise deal.

---

## Phase 5 — Compliance + legal (out of band, runs in parallel)

**Goal:** legal sign-off before any customer signature. Estimated **2-3 working weeks of legal counsel time + ~2 dev days**.

- ⬜ **GDPR / CCPA review** — we store named executives, LinkedIn-derived info. Need DPA template, right-to-erasure flow, data residency considerations.
- ⬜ **Terms of Service + Privacy Policy** — draft, legal review.
- ⬜ **Data processing agreements** template for enterprise customers.
- ⬜ **LinkedIn ToS posture** — we use DDG snippets of LinkedIn URLs; document the legal basis. If we pay for a LI data source (Phase 3B), update.
- ⬜ **Apollo / Perplexity / Firecrawl pass-through ToS** — confirm we're not violating any upstream provider's terms by reselling derived insights.
- ⬜ **Data deletion endpoints** — `DELETE /api/me` and `DELETE /api/workspaces/:id` that fully purge tenant data.

---

## Phase 6 — GTM / launch readiness (out of band)

**Goal:** the product is buyable. Estimated **2-3 working weeks** running in parallel with Phase 4-5.

- ⬜ Pricing page on marketing site
- ⬜ Demo video (60-90 seconds) showing: conference floor → click exhibitor → brief drawer → quick decision
- ⬜ Onboarding flow: new workspace → first conference → first brief
- ⬜ Customer success playbook + first 30 days
- ⬜ Sales collateral: one-pager, deck, ROI calculator
- ⬜ Documentation site (the brief JSON contract, prompt customization, lead-file schema)

---

## Critical path summary

The shortest path to "we can sell this" is:

1. Phase **1B** (content port) — 1-2 days
2. Phase **1C** (brief JSON contract) — 1 day
3. Phase **1D** (output shape unification) — 1 day
4. Phase **1E** (retire Python) — ½ day
5. Phase **2A-2C** (frontend Prisma + API + drawer) — 4-5 days
6. Phase **4A** (auth) — 3-4 days
7. Phase **4B** (billing) — 2-3 days
8. Phase **5** (legal sign-off) — runs in parallel, depends on Phase 4 outputs

**Critical-path total: ~14-17 working days for one engineer + legal counsel in parallel.**

Phase 3 (production hardening) and Phase 6 (GTM) can run on a separate track and don't block the critical path until the very end.

---

## Risk register

⛔ **LinkedIn ToS / paid-data costs** — current pipeline depends on Firecrawl which is bot-blocked on LinkedIn. We get thin coverage. Either pay a real LI data source (~$200-1000/mo) or accept the recall gap permanently. Decision blocking 3B.

⛔ **Multi-tenant data isolation correctness** — if we ship Phase 4 with a bug in the row-level access middleware, one tenant could see another's briefs. This is an existential bug. Recommend a separate hardening pass with a security review checklist before any external customer onboarding.

🟡 **Cost variance per brief** — currently a brief is ~$0.50-2.00 (Perplexity is the dominant cost). With Phase 1B's pessimistic queries and Phase 3B's stronger PersonalizationWriter model, this could drift up. Need a cost ceiling per run and a fallback when it's exceeded.

🟡 **Conference-floor mobile UX** — the App.tsx works fine on desktop. The original CTO request was specifically for conference-floor use (walking, phone, business cards). The current frontend doesn't have a mobile-first treatment or a card-capture feature. Add to Phase 2 if confirming the use case.

🟡 **Two backends still alive during the gap** — if Phases 1B-1E take longer than 1 sprint, the team has to be disciplined about not adding features to `prospect_brief/`. Document a code-freeze date.

---

## What's NOT on this roadmap (deliberately)

- **Slack/Teams integrations** — out of scope until first 5 paying customers.
- **Mobile-native app** — out of scope. The conference-floor case can be served by a mobile-responsive web app.
- **Real-time collaboration on briefs** — out of scope. Briefs are mostly written-once-read-many.
- **Custom LLM fine-tuning** — way out of scope until we have enough usage data to even consider it.
