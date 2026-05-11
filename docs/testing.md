# Crawler2 — Testing Guide

_Last updated: 2026-05-11_

---

## Overview

Crawler2 has three test files, all hermetic — no network access, no API keys required. Every test runs against real production code; only the five agent functions are mocked in the integration test. The full suite completes in under one second.

```
src/lib/jsonExtract.test.ts     — 9 unit tests
src/lib/briefRenderer.test.ts   — 10 unit tests
src/orchestrator.test.ts        — 6 integration tests
────────────────────────────────────────────────
Total                           — 25 tests
```

---

## Running the Tests

### Full suite

```bash
npm test
# or
npx vitest run
```

### Watch mode (re-runs on file change, useful during development)

```bash
npx vitest
```

### Single file

```bash
npx vitest run src/lib/briefRenderer.test.ts
```

### Type-check only (no tests executed)

```bash
npm run typecheck
# or
npx tsc --noEmit
```

### Dry-run (validates a lead file without any API calls)

```bash
npx tsx src/index.ts --lead brantley-lead.json --dry-run
```

The dry-run parses and validates the lead, prints the archetype, keywords, and a cost estimate, then exits. No agents are run and no profile folder is written.

---

## Test Framework

| Tool | Role |
|---|---|
| **Vitest 1.x** | Test runner and assertion library |
| **vi.mock** | Stubs the five agent modules in the integration test |
| **tsx** | TypeScript executor used by `npm run dev` / `--dry-run` |
| **tsc --noEmit** | Separate type-check step (not part of `vitest run`) |

Vitest is configured entirely through `package.json` defaults — there is no `vitest.config.ts`. It auto-discovers files matching `**/*.test.ts` and runs them with native ESM support.

---

## Test File Breakdown

### 1. `src/lib/jsonExtract.test.ts` — JSON Extraction Unit Tests

**What it tests:** `extractJson()`, the helper that pulls a JSON object or array out of a raw LLM response string. This is critical because agents sometimes wrap their JSON in markdown fences or precede it with prose. If this function fails or guesses wrong, every downstream Zod parse fails.

**Cost: $0.00** — pure string parsing, no I/O of any kind.

| Test | What it asserts |
|---|---|
| Bare JSON object | `{"a": 1}` parses correctly |
| Bare JSON array | `[1, 2, 3]` parses correctly |
| Strips ` ```json ` fences | Code-fenced output is unwrapped before parsing |
| Strips fenceless ` ``` ` | Fences without a language tag are also handled |
| Finds JSON after leading prose | "Sure, here is the JSON: {...}" extracts just the object |
| Braces inside string values | `{"label": "weird {value}"}` does not confuse the brace-matcher |
| Escaped quotes inside strings | `{"q": "he said \"hi\""}` is parsed correctly |
| Throws on malformed JSON | `"not json at all"` must throw rather than silently return undefined |
| Throws on unclosed brace | `{"oops": 1` must throw rather than guess |

The last two tests are especially important — we want loud failures, not silent data corruption.

---

### 2. `src/lib/briefRenderer.test.ts` — Brief Renderer Unit Tests

**What it tests:** `renderBrief()`, which turns a `VerifiedBrief` + `SourcePack` into the final `brief.md` markdown the AE reads. Stability here means AEs see consistent, predictable formatting regardless of which agent produced the underlying data.

**Cost: $0.00** — pure string rendering, no I/O of any kind.

Fixtures used: a `Lead` for "Northwind Logistics", a `SourcePack` with three sources (two used, one intentionally unreferenced), and a `VerifiedBrief` containing icebreakers, value hooks, talking points, and one objection prediction.

| Test | What it asserts |
|---|---|
| H1 heading | Markdown starts with `# Discovery Prep — Northwind Logistics` |
| Meeting metadata | AE name, meeting label, and year are present |
| Required sections | `## TL;DR`, `## Call Objective`, `## Icebreakers`, `## Value Alignment Hooks`, `## Potential Red Flags`, `## Talking Points`, `## Objection Predictions` all present |
| TL;DR + Call Objective | Both sections render and the objective text appears |
| Empty section placeholder | Empty `potentialRedFlags` renders as `_None._` rather than being dropped |
| Inline source citations | `[src-1]` and `[src-2]` appear after the items that cite them |
| Objection format | Objections render as `**They might say:** / **You can respond:**` pairs |
| Sources section filters | `## Sources` lists only cited sources; `src-99` (unreferenced) is absent |
| Verification failure warning | When `passedVerification: false`, a warning line appears at the bottom |
| Verification pass — no warning | When `passedVerification: true`, no warning is present |

---

### 3. `src/orchestrator.test.ts` — End-to-End Integration Test

**What it tests:** The full orchestrator pipeline — agent sequencing, folder layout, file writes, cost ledger, and brief rendering — with all five agents replaced by stubs that return deterministic fixtures instantly.

**Cost: $0.00** — all five agent modules are mocked via `vi.mock`. No OpenAI, Perplexity, Firecrawl, or Apollo calls are made.

**Setup:** Before the test suite imports anything, environment variables are set in-process:

```typescript
process.env.OPENAI_API_KEY     ||= "test-openai"
process.env.PERPLEXITY_API_KEY ||= "test-perplexity"
process.env.FIRECRAWL_API_KEY  ||= "test-firecrawl"
process.env.PROFILES_DIR        = tmpRoot  // OS temp directory
```

`PROFILES_DIR` is pointed at a fresh `mkdtempSync` directory so tests never write to `./profiles` and are automatically cleaned up after the suite via `rmSync`.

**Mocked agents and their fixture returns:**

| Agent | Fixture |
|---|---|
| `runResearcher` | `SourcePack` with 2 sources (`src-1` news, `src-2` exec_interview) |
| `runSignalExtractor` | `Signals` with 1 initiative signal citing `src-2` |
| `runRiskDetector` | `Risks` with 0 risks |
| `runPersonalizationWriter` | `DraftBrief` with 2 icebreakers, 2 value hooks, 3 talking points |
| `runQaVerifier` | `VerifiedBrief` wrapping the draft, `passedVerification: true` |

All mocked agents return `{ result, usage: ZERO_USAGE }` — no tokens are counted, the cost ledger shows `$0.000`.

**Tests:**

| Test | What it asserts |
|---|---|
| Absolute paths | `profilePath` and `briefPath` are absolute filesystem paths |
| Folder name | Profile path contains the company slug (`acme-corp`) under `tmpRoot` |
| File layout — top level | `brief.md` and `run.json` exist at the root of the profile folder |
| File layout — research/ | `sources.json`, `signals.json`, `risks.json`, `draft-brief.json`, `verified-brief.json` all exist under `research/` |
| Brief content | `brief.md` starts with `# Discovery Prep — Acme Corp` and contains `[src-1]` and `[src-2]` citations |
| Run record | `run.json` contains `lead.company = "Acme Corp"`, `startedAt`, `finishedAt`, `verified`, and no `error` field |

---

## Cost of a Real Pipeline Run

The test suite costs nothing. A live production run against real APIs is a different story. Cost depends on company footprint (how much public coverage exists), archetype, and whether `APOLLO_API_KEY` is set.

### With Apollo configured (recommended)

Apollo handles headcount, funding, tech stack, and executives cheaply, which suppresses 1–2 `sonar-deep-research` calls.

| Stage | Model / Service | Typical calls | Estimated cost |
|---|---|---|---|
| Apollo company enrich | `apollo/company_enrich` | 1 | ~$0.01 |
| Apollo people search | `apollo/people_search` | 1–2 | ~$0.01–$0.02 |
| Perplexity breadth | `sonar-pro` | 1–3 | ~$0.01–$0.03 |
| Perplexity deep research | `sonar-deep-research` | 1–2 | ~$0.05–$0.10 |
| Firecrawl scrapes | Firecrawl | 0–5 | ~$0.00–$0.025 |
| OpenAI agents (×5) | `gpt-4o` | 5 agent loops | ~$0.10–$0.30 |
| **Total** | | | **~$0.18–$0.46 / run** |

### Without Apollo (Perplexity-only fallback)

When `APOLLO_API_KEY` is absent, the Researcher asks Perplexity for firmographics and people — which typically requires 1–2 extra `sonar-deep-research` calls.

| Stage | Model / Service | Typical calls | Estimated cost |
|---|---|---|---|
| Perplexity breadth | `sonar-pro` | 2–4 | ~$0.02–$0.04 |
| Perplexity deep research | `sonar-deep-research` | 2–3 | ~$0.10–$0.30 |
| Firecrawl scrapes | Firecrawl | 0–5 | ~$0.00–$0.025 |
| OpenAI agents (×5) | `gpt-4o` | 5 agent loops | ~$0.10–$0.30 |
| **Total** | | | **~$0.22–$0.67 / run** |

### Pricing reference (as of 2026-05)

| Model / Service | Input | Output | Notes |
|---|---|---|---|
| `sonar-pro` | $1.00 / M tokens | $3.00 / M tokens | Perplexity breadth scan |
| `sonar-deep-research` | $5.00 / M tokens | $15.00 / M tokens | Perplexity deep research |
| `gpt-4o` | $2.50 / M tokens | $10.00 / M tokens | All five OpenAI agents |
| `gpt-4o-mini` | $0.15 / M tokens | $0.60 / M tokens | Available via `model` override |
| Firecrawl | $0.005 / scrape | — | Hard cap: 5 scrapes/run |
| Apollo company enrich | ~$0.01 / call | — | Subscription; estimate only |
| Apollo people search | ~$0.01 / call | — | Subscription; estimate only |

Actual per-run costs are written to `run.json` under the `costs` key and printed to the terminal at the end of every run. The Apollo per-call estimate is configurable via `APOLLO_ESTIMATED_COST_USD_PER_CALL` in `src/lib/costLedger.ts` — set it to `0` if you'd rather not count subscription calls.

---

## What Is Not Tested

The following are not covered by automated tests and should be validated manually when the corresponding prompts or schemas change:

- **Researcher prompt correctness** — whether the model actually uses Apollo before Perplexity, respects the `excludeKeywords` filter, and produces ≥8 sources for a well-known company. Run `egnyte.json`, `joist-ai.json`, and `seev.json` after any `researcher.md` change.
- **Signal / Risk / Writer / Verifier prompt quality** — the agent output shapes are tested in the integration test via mocks, but the actual LLM behavior is not. Review real `brief.md` outputs after prompt changes.
- **Email delivery** — the Resend integration is exercised only in a real run with `RESEND_API_KEY` and `EMAIL_FROM` set.
- **Apollo API responses** — `apollo.ts` is not unit-tested; the API contract is validated by running a real enrichment call (`npx tsx src/index.ts --lead <file>` with a valid key).
