# Cost optimization — getting the per-brief bill (and the redundant-rerun bill) down

_Last updated: 2026-05-15_

A full brief today costs **~$0.30–$0.80**. On the 40-company AECTech pipeline that's $12–32 once, and the same again every time we refresh. Most of the cost is wasted on tokens the model didn't need to see, and on work we already did on a prior run.

This doc is the ranked playbook for cutting that bill — split by category so leadership can pick where to invest:

1. **Between-run redundancy** — your specific ask: don't redo extraction when sources haven't changed
2. **Per-run token waste** — the SourcePack is sent 4× to 4 different agents today
3. **Model selection** — gpt-4o everywhere is overkill for two of the five agents
4. **Smart scheduling** — don't run when there's nothing to find
5. **Telemetry** — make the next round of optimization data-driven

Each item carries **L** (leverage, dollars saved per run, 1–5) and **C** (cost to implement, 1–5).

---

## Where the money actually goes today

Per run, observed on real fixtures + the cost ledger:

| Component | Typical | Worst | Why |
|---|---|---|---|
| Perplexity sonar-deep-research | $0.10–0.30 | $0.50 | 2–3 calls at $0.05–$0.10 each |
| Perplexity sonar-pro | $0.02–0.05 | $0.10 | 1–2 breadth scans |
| OpenAI gpt-4o (5 agents) | $0.15–0.40 | $0.60 | Writer is the heaviest (~$0.08), Verifier next |
| Firecrawl | $0.005–0.025 | $0.025 | 1–5 scrapes, hard-capped |
| Apollo | $0.02 (estimated) | $0.02 | 2 calls per run |
| **Total** | **$0.30–$0.80** | **$1.20** | |

The two dominant lines are **Perplexity sonar-deep-research** and **OpenAI gpt-4o agents**. Both are the targets below.

---

## Tier 1 — Between-run redundancy (the user's ask)

When you re-run the same company tomorrow, ~90% of the SourcePack is usually identical. The current pipeline pays full freight for that. These five items make same-source reruns near-free.

### 1. Same-day SourcePack cache (`profilesDir`-backed)
**L 5 · C 2 · 1 day**

Cache key: `(normalized-domain, YYYY-MM-DD) → SourcePack`. When the orchestrator starts:

- If a fresh cache hit exists (within TTL, default 24h), skip the entire Researcher phase and load the cached SourcePack.
- The orchestrator still runs the four downstream agents (Signal / Risk / Writer / Verifier) since the Lead may have changed (different callObjective, different competitiveContext).
- Cost on a same-day refresh drops from ~$0.50 to ~$0.05 (just the four downstream agents on cached input).

Implementation: small store in `src/lib/sourcePackCache.ts`, files written to `profilesDir/.cache/sourcepack/<domain>/<date>.json`. Bypass with `?refresh=true` (already in the roadmap as Phase 3H).

**Already in the roadmap** as 3H. Pull it forward.

### 2. Source-level fingerprint cache (URL → snippet)
**L 4 · C 2 · 1 day**

Hash each `(url, title, publishedAt)` and cache the snippet + category bytes long-term (90 days). When the Researcher fires a Perplexity query and the returned URLs overlap with the cache, reuse the snippet instead of re-fetching with Firecrawl.

- Saves Firecrawl calls (~$0.005 each) on overlapping URLs.
- More importantly: lets us skip the LLM "snippet selection" step from full-page content, which is one of the unmeasured silent token costs today.
- Survives across companies — if the same trade-press URL keeps coming up across runs, it's cached once.

Implementation: `src/lib/sourceCache.ts`, content-addressed by URL hash, stored in `profilesDir/.cache/sources/<sha1>.json`.

### 3. Incremental brief regeneration
**L 5 · C 3 · 2 days**

On a refresh, compute the diff between the new SourcePack and the previous run's:

- **0 new sources** → return the previous brief unchanged. **$0 cost.** (This is the case the user cared about most.)
- **1–3 new sources** → fire ONLY the Writer + Verifier on the augmented pack, with the previous brief as additional context ("here's the prior brief; integrate these new sources without re-extracting unchanged signals"). Skip the Signal Extractor and Risk Detector entirely. **~$0.10 vs ~$0.50.**
- **≥4 new sources or category mix changed** → full pipeline as today.

Implementation: orchestrator gains a `mode: "incremental" | "full"` decided at run start. Writer prompt gets a "you're updating this prior brief, not rebuilding" variant.

### 4. Apollo 30-day cache
**L 2 · C 1 · 2 hours**

Apollo firmographics + people data changes slowly. Cache for 30 days by domain. Saves the 2 Apollo calls per run (~$0.02), and more importantly trims ~5 seconds off the run.

Implementation: trivial layer above `apolloCompanyEnrich` / `apolloPeopleSearch` in `src/tools/apollo.ts`.

### 5. Embedding-based dedup (cross-run, cross-company)
**L 3 · C 3 · 2 days**

Embed each source snippet (use `text-embedding-3-small`, $0.02 per 1M tokens — cents per run). Store the vectors in a tiny SQLite + sqlite-vec or just on-disk JSON with cosine search.

When the next Researcher run returns candidate sources, check each against the cached vectors. If cosine > 0.85 against an existing snippet, reuse the cached one. Especially valuable across companies — the same "AEC software in 2026" listicle is going to surface 10x times across the pipeline.

Implementation: `src/lib/embeddingCache.ts`. Embedding cost is negligible against the savings. Only worth it once Tier 1 #1 and #2 are in.

**Tier 1 cumulative impact:**

| Scenario | Today | After Tier 1 |
|---|---|---|
| Same-day refresh, no new sources | $0.50 | **$0.00** |
| Same-day refresh, 2 new sources | $0.50 | **$0.10** |
| Next-day refresh, mostly same sources | $0.50 | **$0.15** |
| Full new company brief | $0.50 | $0.40 |

For the 40-company pipeline, refreshing weekly: today ~$20/week, after Tier 1 ~$5/week.

---

## Tier 2 — Per-run token waste

These cut the cost of a *new* brief (no cache benefit). Useful for first-time companies and the inevitable forced full-refresh.

### 6. Source digest, not full SourcePack, for downstream agents
**L 5 · C 3 · 2 days**

Today the SourcePack is sent verbatim to all four downstream agents (SignalExtractor, RiskDetector, PersonalizationWriter, QAVerifier). That's 4× transmission of the same ~24,000 chars (~6,000 tokens).

Add a "SourceCondenser" pass: ~$0.02 cheap call that turns the SourcePack into a structured digest:

```
src-1 [news, 2026-04-22] Northwind Q1 revenue up 12%, mentions data consolidation as priority.
src-2 [social, 2026-04-30] Pat Lee (VP Data) — relocating data org to Charlotte.
src-3 [news, 2026-03-15] Self-service yard analytics targeted for Q3.
```

50 such bullets totals ~5k chars / ~1.5k tokens. Downstream agents see the digest *plus* the ability to request a specific source's full snippet by id (rare — the digest is usually enough).

Savings: ~70% of input tokens across 4 agents.
- Today: ~24k chars × 4 agents = ~96k chars resent = ~24k input tokens × $2.50/M = $0.06 wasted per run on duplication.
- Plus the per-agent input portion of each call.

This is the single biggest "I'm paying for the same tokens 4 times" lever in the codebase today.

**Where it lands:** new `src/agents/sourceCondenser.ts`, runs after the Researcher and before everyone else. `src/agents/sharedUserBlocks.ts` updated to feed the digest instead of the full pack.

### 7. Drop irrelevant sources before downstream agents
**L 3 · C 1 · 4 hours**

After the SignalExtractor runs, any source not cited in `signals[].supportingSourceIds` AND not cited in `risks[].supportingSourceIds` is dead weight from this point forward. Strip those from the SourcePack before the Writer and Verifier ever see them.

Typical Researcher returns ~25 sources, Signals + Risks cite ~12 of them. Saves ~50% of source-related tokens in the two heaviest downstream agents.

**Where it lands:** `src/orchestrator.ts` — after SignalExtractor + RiskDetector run, intersect cited ids and pass a filtered SourcePack downstream.

### 8. Cap Perplexity output tokens
**L 2 · C 1 · 30 min**

Today `src/tools/perplexity.ts` sets no `max_tokens` on the Perplexity request. Output occasionally balloons to 6–8k tokens (mostly preamble fluff). Set:

- `sonar-pro`: `max_tokens: 1500` (breadth scans don't need more)
- `sonar-deep-research`: `max_tokens: 4000`

Sonar-deep-research at $15/M out — capping at 4k saves up to $0.06 per call on bloated responses.

### 9. Tighten the Researcher iteration cap with early-exit
**L 2 · C 1 · 1 hour**

Today `maxIterations: 16`. Real runs typically use 8–12; the wasted iterations on common-name companies (where the model keeps re-querying with slight variations) cost real tokens. Add an early-exit instruction to the Researcher prompt: *"If by iteration 8 you have ≥8 high-confidence sources, stop and synthesize."*

Saves 2–4 wasted iterations (each is a full prompt + tool result) on the runs that hit them.

### 10. Verifier scoped to claims with `evidenceQuote`
**L 3 · C 1 · 4 hours**

The LLM verifier today reads the entire DraftBrief and re-judges every claim. With the deterministic verifier (`src/lib/verify.ts`) now substring-checking every `evidenceQuote`, the LLM verifier's job is much narrower: judge whether the *interpretation* of the quote is correct.

Refactor the LLM verifier prompt to only judge claims that:
1. Have an `evidenceQuote` that passed the deterministic check, AND
2. Have a structured value (e.g. a year, a dollar amount, a person+role pairing) that needs context-sensitive judgement.

Typical brief: ~30 claims emitted, ~22 pass deterministic verification, ~14 actually need LLM judgement. Verifier input drops by 50%.

### 11. Pass only relevant sections to the Writer
**L 2 · C 2 · 1 day**

The PersonalizationWriter today receives the full SourcePack + Signals + Risks. But most sections it writes only need a subset:

- `executiveSnapshot` needs Apollo + financial signals
- `latestNews` needs `category: "news"` sources only
- `buyingCommittee` needs Apollo people + social sources
- `attendeeIntel` same

Refactor the Writer into smaller sub-agents OR keep it monolithic but pre-filter the SourcePack subset per section in the prompt. Saves ~40% of Writer input tokens.

### 12. Drop "stale" auditorReasoning + redundant detail fields
**L 1 · C 1 · 2 hours**

`Risks[].auditorReasoning` is a forced one-paragraph chain-of-thought. It improved risk detection quality but it doubles the Risks payload size and the Risks payload is passed downstream to the Writer + Verifier. Either:
- Strip `auditorReasoning` before passing Risks downstream (keep it in `risks.json` on disk for audit), OR
- Move it to a separate file the renderer doesn't include.

Same trick for `Source.snippet` truncation: today the cap is 600 chars. Downstream agents rarely need 600 — 300 is usually enough with a "request full" escape hatch.

---

## Tier 3 — Model selection

### 13. SignalExtractor + QAVerifier on gpt-4o-mini
**L 4 · C 1 · 2 hours**

Today all five agents use `gpt-4o` ($2.50/M in, $10/M out). Two of them don't need it:

- **SignalExtractor** — closed-book extraction over the SourcePack. Pure pattern recognition; gpt-4o-mini ($0.15/M in, $0.60/M out) does this well.
- **QAVerifier** — judgement over individual claims after the deterministic pass has done the hard substring work. Also fine on mini.

Savings: ~$0.10–$0.15 per run on those two agents (out of ~$0.30 today).

Keep gpt-4o on Writer (synthesis quality matters most), Researcher (tool-use loop), and RiskDetector (pattern recognition over rare/adverse signals).

**Where it lands:** `model` parameter on `runAgent` already exists. Just pass `"gpt-4o-mini"` in `src/agents/signalExtractor.ts` and `src/agents/qaVerifier.ts`.

### 14. Researcher: gpt-4o-mini for tool-use, gpt-4o for synthesis
**L 3 · C 3 · 2 days**

The Researcher's agentic loop has two distinct phases:

- **Tool-use** (most iterations): decide which tool to call next. gpt-4o-mini handles this fine.
- **Synthesis** (final iteration): turn all tool results into the SourcePack JSON. gpt-4o here.

Today both happen in the same agent so we pay gpt-4o rates for all 12 iterations. Split into:

- `phase1Agent` (gpt-4o-mini): runs the tool loop until termination signal.
- `synthesisAgent` (gpt-4o): single call to format the final SourcePack.

Saves ~$0.10 on a typical Researcher run. Higher engineering complexity than #13 — defer until #13 lands and we have observability into the actual mini-vs-4o quality delta.

### 15. Perplexity sonar-pro instead of sonar-deep-research for routine angles
**L 4 · C 1 · 1 hour**

sonar-deep-research is 5–10× more expensive than sonar-pro. Today the Researcher uses deep-research for "news / interviews / job_postings / financials / people" focus angles. But for many of those, sonar-pro's single-shot search is plenty:

- **news** — sonar-pro with `recency: "month"` usually gets the same articles
- **job_postings** — sonar-pro is fine; postings are timestamped + structured
- **people** — sonar-pro on company name + "C-suite OR VP" works for ~80% of cases

Reserve sonar-deep-research for the genuinely-hard angles: **financials** (digging through 10-Q text), **interviews** (multi-step reasoning to confirm the person), and **competitive positioning** (synthesis across multiple sources).

Today's typical mix is 1 sonar-pro + 3 sonar-deep-research = ~$0.20. Smart mix is 3 sonar-pro + 1 sonar-deep-research = ~$0.08. **Half the variable cost line.**

**Where it lands:** `src/prompts/researcher.md` Phase 2 table — recategorize each angle into "pro" vs "deep-research".

### 16. Eliminate the Writer→Verifier retry loop's hidden cost
**L 2 · C 1 · 1 hour**

`runAgentWithSchema` retries once on Zod validation failure. The retry sends the full system prompt + previous output + error. For the Writer (8k output tokens), a single retry on bad JSON costs ~$0.04 — and the Writer is the most common offender because its output is the largest.

Cheaper fix: switch the Writer to OpenAI's `response_format: { type: "json_schema" }` (structured outputs), which guarantees valid JSON without retries. Saves on the long tail of Writer failures.

---

## Tier 4 — Smart scheduling

### 17. "Has anything actually changed?" pre-flight
**L 5 · C 2 · 1 day**

Before kicking off a full pipeline on refresh, fire one cheap sonar-pro call: *"What is new about `<company>` since `<lastBrief.generatedAt>`?"*. Cost: ~$0.01.

- If the answer surfaces 0–1 new items → return the cached brief, do nothing else. **Saves $0.49.**
- If 2–3 new items → trigger incremental regeneration (Tier 1 #3).
- If ≥4 new items → trigger full rerun.

Combined with #3, this turns most refreshes into a $0.01 operation.

**Where it lands:** orchestrator entry point. Skip when `forceRefresh: true`.

### 18. Cron pre-meeting refresh, no manual triggers
**L 3 · C 2 · 1 day**

The iPad viewer's refresh button is convenient but Ryan-tappy. Most refreshes happen "I want fresh data, run it now." Replace most of those with:

- Auto-refresh 24h before any scheduled meeting (via the schedule skill / cron).
- Auto-refresh weekly for any company with `meetingAt` set within the next 30 days.
- Otherwise no automatic refreshes — Ryan's tap is only needed for ad-hoc.

Combined with #17, the refresh-storm scenario (Ryan opens the iPad and taps refresh on 5 companies) becomes effectively free.

### 19. Skip past-meeting briefs entirely
**L 2 · C 1 · 30 min**

Today the batch runner re-generates for every lead in `leads/`. If the meeting was last week, the brief is read-once value at best. Skip leads where `meetingAt < now - 7d`.

### 20. Batch cross-company "industry pulse" queries
**L 3 · C 3 · 2 days**

When running 40 companies, every Researcher fires a "what's new in AEC AI 2026?" style breadth scan. That's 40 redundant queries. Pull the industry-wide pulse out of the per-run flow:

- Once per day, fire ONE industry-wide sonar-deep-research call ("AEC software industry — recent news, funding rounds, acquisitions, exec moves").
- Cache the result for 24h. Every per-company run reads it via a synthetic source `src-industry-pulse-<date>`.
- Per-company Researcher only runs prospect-specific queries.

Saves ~$0.05 per run × 40 runs = $2/day on the pipeline.

---

## Tier 5 — Cost telemetry (table-stakes for the above)

### 21. Per-Perplexity-call cost breakdown in run.json
**L 2 · C 1 · 1 hour**

Today `run.json` shows cost per AGENT but not per Perplexity call. Without that, we can't tell which query angles are expensive but low-yield — and we can't prioritize Tier 3 #15 (sonar-pro vs sonar-deep-research). Extend `costLedger` to record each Perplexity call's `(model, query summary, cost, citations returned)`. Then the next cost-optimization round is data-driven, not guesswork.

### 22. ROI scoring per section
**L 2 · C 2 · 1 day**

Track per-section signal density: claims emitted, claims passing verification, claims with `evidenceQuote`. Sections that consistently come back empty or stripped are candidates for removal from the schema.

For example: if `govContracts` is never populated for `aec_vendor` archetype runs, drop it from the Writer prompt for that archetype — saves a few hundred tokens per run × 40 runs × every refresh.

### 23. Hard per-run cost cap (already in roadmap as 3F)
**L 4 · C 2 · 1 day**

Set `MAX_COST_PER_RUN_USD = 1.50` and abort the Researcher (gracefully — emit whatever it has) if it crosses the cap. Same for the per-AE-day cap. Protects against a single bad lead chewing through $5 on retries + thin-signal escalation + tool loops.

**Already on roadmap**, escalate to alongside Tier 1 items.

---

## Composite scenarios

How the dollar lines move when these compound:

| Scenario | Today | After Tier 1 | After Tier 1+2 | After Tier 1+2+3 |
|---|---|---|---|---|
| **Same-day refresh, 0 new sources** | $0.50 | **$0.00** | $0.00 | $0.00 |
| **Same-day refresh, 2 new sources** | $0.50 | $0.10 | **$0.07** | $0.05 |
| **Next-day refresh, mostly same** | $0.50 | $0.15 | $0.10 | **$0.07** |
| **Brand-new brief, rich footprint** | $0.50 | $0.45 | $0.30 | **$0.22** |
| **Brand-new brief, thin footprint** | $0.40 | $0.35 | $0.25 | **$0.18** |
| **Full 40-company pipeline (cold)** | $20 | $18 | $12 | **$9** |
| **Full 40-company pipeline (weekly refresh)** | $20 | $5 | $4 | **$3** |

Tier 1 alone takes the weekly steady-state from $20 to $5 — the biggest single lift, and the most aligned with your concern about "don't reprocess when nothing's changed." Tier 2+3 are mostly first-run cost cuts.

---

## Recommended ship order (engineering prioritization)

1. **Same-day SourcePack cache (#1)** + **Apollo cache (#4)** + **Incremental regeneration (#3)** — the user's specific ask. Ship as a single PR; one day of work, biggest cost-per-week reduction.
2. **Source digest for downstream agents (#6)** + **Drop irrelevant sources (#7)** — biggest per-run-cost reduction at modest engineering cost.
3. **Tier 3 model selection (#13, #15)** — cheap PRs, immediate cost win. Worth doing alongside #1 since they're decoupled.
4. **"Has anything changed?" pre-flight (#17)** + **cron pre-meeting refresh (#18)** — together these make the iPad's refresh button effectively free.
5. **Source-level fingerprint cache (#2)** + **Embedding-based dedup (#5)** — cross-run wins that compound over months.
6. **Telemetry (#21, #22)** — sets up the next round of data-driven cuts.
7. Everything else as needed.

Items 1–3 are ~1 sprint of focused work and would cut the steady-state weekly bill by ~75%.

---

## Connection to the thin-signal playbook

Some Tier 1 items here interact with the thin-signal improvements in `docs/thin-signal-improvements.md`:

- **Incremental regeneration (#3)** assumes the prior brief was good enough to keep. If the prior brief was thin/low-signal, refresh should re-attempt with the thin-signal expansions, not just patch in new sources.
- **"Has anything changed?" pre-flight (#17)** for thin-signal companies should bias toward "yes, re-run" since the prior brief was likely underspecified.

Both docs land in the same engineering plan — they're complementary, not in tension.
