# Crawler2 — Bugs, Fixes & Improvements Checklist

_Last updated: 2026-05-11 (Apollo re-integration)_

Legend: ✅ Done | 🐛 Bug | 🔧 Fix / Tech Debt | 💡 Improvement

---

## Documentation ✅

- ✅ **`signalExtractor.ts`, `riskDetector.ts`, `qaVerifier.ts`, `personalizationWriter.ts`** — Stale Anthropic prompt-caching comments removed.
- ✅ **`firecrawl.ts`** — "when `web_search` has surfaced a URL" → "when Perplexity has surfaced a URL".
- ✅ **`docs/build-summary.md` — Decision #4/5 stale** — Full decision chain clarified.
- ✅ **`docs/build-summary.md` — Signals schema** — Added `competitive_pressure` and `regulatory_change`.
- ✅ **`docs/build-summary.md` — Risks schema** — Added `evidenceQuote` and `auditorReasoning`.
- ✅ **`docs/build-summary.md` — DraftBrief schema** — Added all missing fields and types.
- ✅ **`prospect_brief/README.md` — Stale caching note** — Corrected to point to the Caching section.

---

## Bugs ✅

- ✅ **`src/tools/email.ts` — `<li>` not closed before `</ul>`** — `closeList()` now closes the open `<li>` before pushing `</ul>`.
- ✅ **`src/lib/costLedger.ts` — OpenAI cost hardcoded to `gpt-4o`** — `getCostSummary` now accepts an optional `model` field.
- ✅ **`src/lib/costLedger.ts` — Silent $0 for unknown models** — `recordTokenCall` and `recordCallCost` now warn on missing pricing.
- ✅ **`src/lib/agentClient.ts` — Retry drops `customTools`** — Added comment explaining intentional omission on the JSON-fix retry.
- ✅ **`src/lib/briefRenderer.ts` — `numberedSection` ignores `BriefItem.label`** — Fixed to match `labeledSection`.
- ✅ **`src/lib/agentClient.ts` — `choices[0]!` non-null assertion** — Replaced with an explicit guard that throws a clear error on empty choices.
- ✅ **`src/lib/agentClient.ts` — `maxIterations` throws without context** — Now logs the last 4 messages before throwing.

---

## Tech Debt ✅

- ✅ **`src/tools/apollo.ts`** — Deleted (dead code, nothing imported it).
- ✅ **`src/tools/webSearch.ts`** — Deleted (exported `null`, nothing imported it).
- ✅ **`package.json` — `resend` in prod deps** — Moved to `devDependencies`.
- ✅ **`prospect_brief/run_<newcompany>.py`** — Renamed to `run_example.py` with a usage docstring.
- ✅ **`docs/build-summary.md` — "Files removed" header** — Renamed to "Files removed or emptied".
- ✅ **`src/lib/claudeClient.ts`** — Renamed to `agentClient.ts`; all imports updated; old file deleted; `tsc --noEmit` exits 0.

---

## Improvements ✅

- ✅ **`src/lib/costLedger.ts` — `gpt-4o-mini` missing from pricing** — Added at $0.15/M in / $0.60/M out. Also corrected `sonar-deep-research` from $2/$8 → $5/$15 to match Perplexity docs.
- ✅ **`src/tools/firecrawl.ts` — Firecrawl cap advisory-only** — Hard cap of 5 scrapes/run now enforced in code; `resetFirecrawlCap()` wired into orchestrator.
- ✅ **`src/tools/perplexity.ts` — No retry on transient errors** — Added `fetchWithRetry` with 3 attempts at 2s/4s/8s backoff for 429/5xx; used by both `perplexitySearch` and `perplexityDiscovery`.
- ✅ **`src/orchestrator.ts` — Parallel stage progress indistinguishable** — Signal and Risk each emit their own completion line inside the `Promise.all`.
- ✅ **`src/index.ts` — No dry-run option** — Added `--dry-run` flag: validates lead, prints archetype/keywords/cost estimate, exits without API calls.
- ✅ **Agent prompt files re-read on every call** — All five agents now cache their prompt string in a module-level `_cachedPrompt` variable on first call.
- ✅ **`src/lib/agentClient.ts` — Misleading filename** — Renamed from `claudeClient.ts` to `agentClient.ts`.

---

## Apollo Re-integration ✅

- ✅ **`src/tools/apollo.ts` — Re-created with real API calls** — `apollo_company_enrich` (organization/enrich endpoint) and `apollo_people_search` (mixed_people/search endpoint) exposed as `CustomTool` objects with Zod input schemas. Graceful error if `APOLLO_API_KEY` is unset.
- ✅ **`src/config.ts` — `apolloApiKey` added as optional field** — Maps to `APOLLO_API_KEY` env var. Absent key triggers graceful degradation (Researcher skips Phase 0).
- ✅ **`src/lib/costLedger.ts` — Apollo call pricing added** — `company_enrich` and `people_search` tracked in `CALL_PRICING` at `$0.01/call` (configurable constant). Cost line appears in run.json.
- ✅ **`src/agents/researcher.ts` — Apollo tools wired in** — Tools injected into agent tool list only when `apolloApiKey` is set. `apolloAvailable` flag passed to model in the user message so prompt can branch. `maxIterations` raised to 16 to accommodate the extra Phase 0 calls.
- ✅ **`src/prompts/researcher.md` — Full decision framework** — New Phase 0 (Apollo first: company enrich + people search); updated Phase 1 Perplexity breadth to skip questions already answered by Apollo; added Apollo → SourcePack serialization rules (stable IDs `src-apollo-company` and `src-apollo-<name>`); archetype-specific funding call now skips when Apollo returned funding data. Tool decision table at top of prompt.
- ✅ **`.env.example` — `APOLLO_API_KEY` documented** — Comment explains Apollo's role and the graceful fallback.

---

## Open Questions (carry forward)

- [ ] **Validation runs** — Run `egnyte.json`, `joist-ai.json`, `seev.json` after any Researcher prompt change.
- [ ] **Title focus per archetype** — `aec_vendor` Researcher still defaults to a generic technical-buyer title list; consider tightening to founders, CEOs, Heads of Product/AI.
- [ ] **gpt-4o vs stronger model for PersonalizationWriter** — Evaluate after seeing real briefs.
- [ ] **Profile retention policy** — `./profiles/` grows indefinitely; set a retention window before production.
- [ ] **PII / compliance** — Named executives in briefs; confirm acceptable use.
- [ ] **LinkedIn coverage** — Perplexity surfaces LinkedIn URLs but Firecrawl is bot-blocked; investigate paid LI-data source if needed.
- [ ] **`docs/architecture.svg`** — Verify diagram still reflects current pipeline (Perplexity, not web_search/Apollo).
- [ ] **`samples/exampleBrief.md`** — Regenerate from a real run for accurate prompt-tuning reference.
- [ ] **`prospect_brief/` strategist prompt** — `.cache/strategist/` exists but no `prompts/strategist.md`; add or clean up.
