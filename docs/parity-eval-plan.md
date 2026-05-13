# Parity eval — verifying the Python → TypeScript port did not regress brief quality

The Tier 1 consolidation moved the deterministic verifier, the audience-aware question banks, the RPE benchmark table, the weak-risk-signal archetypes, the pessimistic adversarial query, and the confidence-warning banner from `_archived/prospect_brief/` (Python) into the active TypeScript backend (`src/`).

Everything that's mechanically testable is covered by `src/lib/verify.test.ts` (40 unit tests, every historical failure case from Brantley and QRC). What unit tests CAN'T cover is the end-to-end output quality on a real run — that requires actual Perplexity / Firecrawl / Apollo / OpenAI API calls against real prospects.

This document is the plan for closing that gap once someone has API keys at hand.

## The eval

### Inputs

Three prospects with known shapes, already in `leads/`:

- `leads/egnyte.json` — AEC software vendor. Should produce a rich brief (public company, lots of public-source coverage).
- `leads/joist-ai.json` — small AEC AI startup. Should produce a moderate brief.
- `leads/seev.json` — also small. Should produce a thin brief (limited public coverage).

### Step 1 — Generate post-port briefs

```bash
npm run prep -- --lead leads/egnyte.json
npm run prep -- --lead leads/joist-ai.json
npm run prep -- --lead leads/seev.json
```

Each run writes:
- `profiles/<companySlug>/<runId>/brief.md`
- `profiles/<companySlug>/<runId>/brief.json` ← new in this port
- `profiles/<companySlug>/<runId>/run.json`

Copy each `brief.json` to `evals/baseline/<companySlug>.json` as the post-port reference.

### Step 2 — Compare against pre-port baselines

If pre-port briefs exist in `profiles/<companySlug>/*/brief.json` (from runs before this consolidation), spot-check the following:

| Field | Pre-port (Python) | Post-port (TS) | Expected change |
|---|---|---|---|
| Section count | richer (Snapshot, Mission, Federal IDs, Tech Stack, etc.) | flat (executiveSnapshot, icebreakers, valueHooks, talkingPoints, etc.) | **Different structure but equivalent information density.** Frontend renders via `PublishedBriefSchema`. |
| Source count | varies | similar | Should not drop materially. |
| Claims passing verification | substring-checked | substring-checked + LLM-checked | Should not increase strip rate. |
| `signalQuality` | new field | new field | Both pre-port + post-port now compute this. |
| Audience-tailored talking points | yes (when audience set) | yes (when audience set) | New on TS side; verify it actually appears. |
| Weak-risk-signal archetypes | yes (strategist section) | yes (in `risks[]`) | New shape — moved from a separate strategist block to the risks array. |

### Step 3 — Qualitative spot-checks

Read each brief manually and check:

- **No regression of correctness fixes.** Specifically: Egnyte must not show "Public Company" without a stock-exchange corroborator (we fixed this); Brantley-style impostors (if any in this batch) must be dropped by the relevance gate.
- **Audience-aware talking points fire** when `lead.audience` is set. Try setting `egnyte.json:audience` to "cto" and rerunning — talking points should bias toward stack / build-vs-buy / processing-tax questions.
- **Confidence banner fires** for thin prospects. `seev.json` should produce a brief with a `LIMITED CONFIDENCE` or `LOW-CONFIDENCE` banner.
- **The pessimistic adversarial query** added a 5th breadth-scan call to the Researcher. Check `research/source-pack.json` — if any of the surfaced sources are about lawsuits / OSHA / disputes, they should be in there (or correctly absent if there's no real adverse signal for these specific prospects).

### Step 4 — Cost comparison

Compare `run.json:costs.summary` against pre-port runs. Expectations:

- Researcher cost should rise slightly (+1 sonar-pro call ≈ +$0.01) due to the pessimistic query
- PersonalizationWriter cost should be unchanged (same model, slightly longer prompt)
- RiskDetector cost should be unchanged (slightly longer prompt)
- QAVerifier cost should be unchanged (the deterministic pre-pass runs in microseconds, no API call)

Total budget per brief should still land in the **~$0.50 to $2.00** range. If a run exceeds $5.00, something is wrong — investigate.

### Step 5 — Regression doc

If any of Steps 2-4 fail, write `docs/regression-2026-MM-DD.md` describing:

- Which prospect regressed
- What field/section/quality changed
- Whether the regression is **acceptable** (e.g., stricter verifier dropped a previously-let-through claim — that's a feature, not a bug) or **a real bug**
- For real bugs: open an issue, do not advance to Phase 2

If no regression: green-light Phase 2 (frontend integration). The deterministic verifier + archetype taxonomy + audience banks are now production-ready in TypeScript and the Python pipeline can stay archived.

## Acceptance criteria (in plain English)

Phase 1 consolidation is acceptably complete when:

1. ✅ All Vitest tests pass (already true today, 65/65)
2. ✅ `npx tsc --noEmit` is clean (already true today)
3. ⬜ A brief generated against `leads/egnyte.json` produces a valid `brief.json` that conforms to `PublishedBriefSchema`
4. ⬜ The confidence banner fires for `leads/seev.json`
5. ⬜ Setting `egnyte.json:audience = "cto"` measurably changes the brief's talking points vs the default
6. ⬜ No qualitative regression vs the pre-port Python briefs on any of the three test prospects

(3)-(6) gate the green-light for Phase 2 and can only be checked with real API keys.

## When this happens

Whoever picks this up next: 30 minutes of API budget on the three test prospects is all this needs. After that the Tier 1 consolidation is closeable and we move to frontend integration in earnest.
