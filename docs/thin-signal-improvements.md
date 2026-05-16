# Thin-signal briefs — a playbook for getting more sources

_Last updated: 2026-05-15_

A brief comes back "low" or "thin" when the Researcher's SourcePack has fewer than ~5 sources or the deterministic verifier strips ≥30% of claims. This document is the full checklist of changes that increase source count + depth for those cases — ranked by leverage (impact ÷ cost), so leadership can pick where to invest.

Today's state of play: roughly 1 in 4 of the AECTech-2026 target list (40 companies in `companies.csv`) will come back thin. These are typically small private vendors with no recent funding, no exec interview circuit, and a website that doesn't index well. The fixes below are the difference between "we have nothing on this one, run discovery cold" and "we have enough to lead with a confident hypothesis."

Every item carries an **L** (leverage 1–5), **C** (cost 1–5, where 5 = a week of work), and a current-code reference so the engineer doing the work knows exactly where it lands.

---

## Tier 1 — Highest leverage, ship first (~2–3 dev days total)

### 1. Adaptive query expansion when the breadth scan is thin
**L 5 · C 1 · 2 hours**

When Phase 1 (`perplexity_search`) returns fewer than 5 citations, the Researcher should automatically fire 2–3 broader query angles *before* declaring low-signal. Today it sticks with the planned query set even when the response is empty. Add these fallback angles, in this order:

- **Founder-named queries** — pull founder names from Apollo people search and query each by name + "interview OR keynote OR podcast" individually. Founders of small companies often have personal podcast/blog presence even when the company doesn't.
- **Product-name queries** — query the product name instead of the company name (e.g. "Acelab spec library" instead of just "Acelab"). Surfaces customer discussions on Reddit, AEC trade press, and forums.
- **Customer-shaped queries** — `"<company> case study OR customer story OR testimonial"`. Surfaces who's actually using them.
- **Partner-shaped queries** — `"<company> integrates with OR partners with"`. AEC vendors usually have Procore / Autodesk / BIM360 integrations even when their own marketing is thin.

**Where it lands:** add a `phase1Fallback` block to `src/prompts/researcher.md` and increment `maxIterations` from 16 → 20 in `src/agents/researcher.ts`.

### 2. Direct-scrape the prospect's own website
**L 5 · C 1 · 1 hour**

When Phase 1 is thin, we don't need Perplexity to find the company's own site — we already have `lead.website` in the Lead. Auto-scrape these paths via Firecrawl (only when Phase 1 is thin, to keep the cap intact):

- `<website>` (homepage)
- `<website>/about` and `<website>/team` (often surfaces founders, headcount hints)
- `<website>/blog` and `<website>/engineering` (product + tech signal)
- `<website>/careers` or `/jobs` (hiring as initiative signal)
- `<website>/customers` and `<website>/case-studies`
- `<website>/security` (compliance posture — relevant for CTO meetings)

A small private vendor's careers page alone can yield 3–5 high-quality SourcePack entries that Perplexity completely misses.

**Where it lands:** new `phase1WebsiteScrape` step in `src/agents/researcher.ts` (or via prompt instruction); 5 deterministic scrapes when `phase1Citations.length < 5`.

### 3. Manual source seeding from the Lead
**L 5 · C 1 · 30 min**

Add a `manualSources: { url, note? }[]` field to `LeadSchema`. Ryan and his team often know about a specific blog post, LinkedIn announcement, or trade-press article that wouldn't surface in a general search. The Researcher should:

- Firecrawl each manual URL (counts against the per-run cap).
- Inject the result as a SourcePack entry with `category` inferred from the URL.
- Tag the source `note` so the Writer treats it as authoritative AE-provided context.

**Where it lands:** `src/types.ts` LeadSchema → add `manualSources`. `src/agents/researcher.ts` → Firecrawl loop at top of Phase 3. Lead form on the iPad → "Known sources" multi-line input (one URL per line).

### 4. GitHub presence check (custom tool)
**L 4 · C 2 · 4 hours**

A new `github_search` custom tool that uses the GitHub REST API to look up:

- Does the company have a GitHub org? How many public repos, what languages, last commit date.
- Top-3 most-recently-active repos with description + star count + commit frequency.
- If founders are known: their personal repos and contributions.

For an AEC software vendor, an active GitHub org is real engineering-team-size signal. For a thin-footprint vendor with no Perplexity coverage, GitHub is often the *only* signal that confirms they ship code.

**Where it lands:** `src/tools/github.ts` (new file, mirrors `firecrawl.ts` shape). Use the GitHub REST API; auth header is optional but recommended (`GITHUB_TOKEN`, unauthenticated has 60 req/hour). Add to `src/agents/researcher.ts` Phase 2 with archetype-conditional inclusion (skip for `aec_firm`).

### 5. Crunchbase + PitchBook fallback for funding/firmographics
**L 4 · C 2 · 4 hours (Crunchbase free tier) / 1 day (PitchBook paid)**

When Apollo doesn't have a company (small/private/non-US), Crunchbase's free-tier API often does — and PitchBook's paid API has even better coverage of private vendors. The Researcher should fall back to Crunchbase after `apollo_company_enrich` returns null/empty.

**Where it lands:** `src/tools/crunchbase.ts`. Conditional tool in `src/agents/researcher.ts` Phase 0b (after Apollo). Returns the same `ApolloCompanyData` shape so downstream prompts don't need to branch.

---

## Tier 2 — Medium leverage (~3–5 dev days)

### 6. Adaptive recency window
**L 3 · C 1 · 1 hour**

If the Phase 1 breadth scan at `recency: "month"` returns <5 citations, automatically retry at `"year"` before giving up. Cost: +1 Perplexity call per thin run. Today the recency is fixed at whatever Ryan chose on the iPad form.

**Where it lands:** `src/agents/researcher.ts` Phase 1 retry loop. Surface the retry in `run.json` so we know it happened.

### 7. Founder-name deep dive
**L 4 · C 1 · 1 hour**

After Apollo's people search returns founder names, fire a `perplexity_discovery` call PER founder with `focus: ["interviews"]` and the founder's name in `executiveName`. Cap at 2 founders. Founders of small AEC vendors often have personal speaking circuit / podcast presence that doesn't surface when querying the company name.

**Where it lands:** new sub-phase in `src/agents/researcher.ts` Phase 2; gate on `aec_vendor` archetype + Apollo-people-search returning ≥1 founder.

### 8. SEC EDGAR for public-ticker prospects
**L 3 · C 1 · 3 hours**

When the company is public (Apollo returns a ticker), pull the latest 10-Q, 10-K, and 8-K filings from EDGAR — these are free and indexed by ticker. The 10-K's "Risk Factors" section alone is a goldmine for the Risk Detector.

**Where it lands:** `src/tools/edgar.ts`; only invoked when `apollo.ticker` is set. Public AEC vendors are rare in the target list, but when they exist, this is the single highest-signal source we can pull.

### 9. USASpending.gov for AEC firms
**L 4 · C 2 · 4 hours**

For `aec_firm` archetype (general contractors, owner-operators, design firms), USASpending.gov has every federal contract award by UEI / CAGE / DUNS. Today the Researcher prompt suggests these as Perplexity queries; a direct API call returns structured data far faster and cheaper than asking sonar-deep-research to find them.

**Where it lands:** `src/tools/usaspending.ts`. Only runs for `aec_firm` archetype.

### 10. Wayback Machine snapshot diff
**L 3 · C 2 · 4 hours**

For thin-signal companies that DO have a website, scrape a Wayback snapshot from 6 months ago and compare to today. New features, removed product lines, changed positioning, CEO-blog dropoffs — all real signal that no other source surfaces. Especially useful when the prospect is "quietly pivoting" — no announcement, but the homepage changed.

**Where it lands:** `src/tools/wayback.ts`. Use the Internet Archive's `/wayback/available` and `/wayback/timemap` APIs. Cheap (free) and surprisingly information-dense.

### 11. AE-supplied prior knowledge as a first-class source
**L 4 · C 1 · 30 min**

Ryan often knows things that no public source confirms — "I heard from a friend at Procore that Acelab is on their integration roadmap." Add a `priorKnowledge: string` field to `LeadSchema` (free-form, multi-line). The Researcher injects it as a synthetic `category: "other"` source with `id: "src-ae-prior"` and a note that it's AE-attributed. The Writer can lean on it for the Hypothesis section.

**Where it lands:** `src/types.ts` LeadSchema, `src/agents/researcher.ts` (one-line injection), iPad form (textarea).

---

## Tier 3 — Lower leverage but worth tracking (~1–2 weeks)

### 12. LinkedIn data via paid source (Proxycurl / ScrapingDog)
**L 5 · C 4 · 1 week**

Already on the roadmap risk register. Firecrawl is bot-blocked on LinkedIn — the People section relies on whatever Perplexity synthesizes from search snippets, which for small companies is often nothing. A paid LI data source ($200–1000/month) closes this gap. Highest absolute leverage on small-vendor briefs but highest absolute cost.

**Where it lands:** `src/tools/linkedin.ts` wrapping the chosen provider's API. Phase 0c addition to the Researcher (alongside Apollo).

### 13. Glassdoor / Indeed for sentiment + role mix
**L 2 · C 3 · 3 days**

For thin-signal companies, reviews on Glassdoor often reveal more about the company's actual state than the company's own marketing does — turnover rates, "ghost roles" that stay open for 6 months, founder reputation. Both have semi-public APIs / scrapeable interfaces.

### 14. Reddit + Hacker News mention search
**L 2 · C 2 · 1 day**

Both have public search APIs. Surface any mention of the company or its product. For AEC-specific tools, Reddit's r/architecture, r/civilengineering, r/construction often have user-grade reviews.

### 15. Twitter/X recent posts (paid API)
**L 2 · C 4 · 3 days**

X's API is now paid and rate-limited. Useful when founders are active there, otherwise low-yield for AEC vendors specifically. Defer until Tier 1+2 are in.

---

## Orchestrator-level changes (independent of new tools)

### 16. Two-pass orchestrator with auto-retry on low signal
**L 5 · C 2 · 1 day**

If pass 1 produces `signalQuality: "low"`, automatically fire a second pass with:

- Expanded recency window
- Tier-1 fallbacks 1–5 enabled
- `maxIterations` raised
- Different system-prompt voice ("you are now in thin-footprint mode")

Today the orchestrator gives up after one pass. The second pass costs ~$0.30 but converts a useless brief into a usable one — easy ROI when the first brief was destined for the bin.

**Where it lands:** wrap `runOrchestrator` in a retry loop in `src/orchestrator.ts`; check `signalQuality` on the verifier output and re-enter with augmented Lead.

### 17. Source-quality scoring + diversity push
**L 3 · C 2 · 1 day**

Today the Researcher targets 8+ sources. But 8 mediocre sources (all news listicles citing the same press release) are worse than 4 high-quality ones (an exec interview, a blog post, a job posting, a customer case study). Score each source on:

- Recency (newer = higher)
- Domain authority (founder blog > listicle aggregator)
- Length / specificity (verbatim quote > generic summary)
- Category diversity (penalize 5 sources of the same category)

Pass the score back into the Writer prompt so it knows which sources are reliable.

**Where it lands:** scoring helper in `src/lib/sourceScore.ts`; the Writer prompt gets a score-weighted view of the SourcePack.

### 18. "Open questions" generator for thin briefs
**L 4 · C 1 · 4 hours**

When `signalQuality === "low"`, the Writer should generate a section called "Open questions for the call" — a list of 5–8 specific things the AE should ask BECAUSE they couldn't be answered from public sources. Today the Writer just produces an empty or hallucinated brief and the AE has to invent these questions on the fly. This is the highest-leverage "lemons-into-lemonade" move.

Examples for a thin AEC vendor brief:
- "We couldn't find a recent funding announcement — are you currently raising, or runway-extended from your seed?"
- "Your engineering team's GitHub presence is minimal — is most development closed-source, or is the team smaller than the marketing implies?"
- "Your latest customer case study is from 2024 — what's the most representative deal you've closed in the last 6 months?"

**Where it lands:** `src/prompts/personalizationWriter.md` — add a conditional `## Open questions for the call` section that fires when the Verifier reports thin signal.

### 19. Multi-archetype retry
**L 3 · C 1 · 30 min**

If the lead's `prospectArchetype` was set to `aec_vendor` but the SourcePack is thin, automatically retry with `other` (which uses different query templates and skips the vendor-specific GitHub/case-study queries). And vice versa. Catches archetype-misclassification automatically.

**Where it lands:** orchestrator-level retry; cheap.

### 20. Researcher self-critique loop
**L 3 · C 3 · 1 day**

After Phase 3, hand the SourcePack back to the Researcher with the meta-prompt: "Look at what you collected. What's missing? What's the most valuable angle you haven't covered? Fire up to 2 more queries to fill those gaps." Adds ~$0.10/run; meaningfully better recall on edge cases.

---

## UI-level changes

### 21. "Add a source" button on a low-signal brief
**L 4 · C 1 · 2 hours**

When viewing a thin brief on the iPad, surface a prominent "+ Add a source you know about" button. Ryan pastes a URL, the server Firecrawl-scrapes it, runs ONLY the Writer + Verifier with the augmented SourcePack, and the brief refreshes. Doesn't re-run the expensive Researcher pass.

**Where it lands:** `POST /api/briefs/<runId>/sources` endpoint in `src/server.ts`; viewer button on rich/moderate/thin/low-signal briefs alike.

### 22. "What we couldn't find" panel on thin briefs
**L 3 · C 1 · 1 hour**

When the brief comes back low-signal, replace the empty-section copy ("Footprint too thin to surface icebreakers") with a dedicated panel that lists what we tried and what we got — so Ryan walks in knowing the gaps:

```
WHAT WE COULDN'T FIND
- No recent funding announcement (Apollo: $0 reported)
- No exec interview circuit (0 podcasts/keynotes found)
- No GitHub organization
- No publicly named customers since 2024
- LinkedIn coverage thin (only 3 named employees surfaced)
```

This is more useful than rendering nothing — it tells Ryan exactly what to ask on the call.

### 23. "Re-run with expansion" affordance
**L 3 · C 1 · 30 min**

Button on the brief detail panel for low/thin briefs: "Try again — broader recency, deeper scan". Kicks off the orchestrator with Tier-1 fallbacks enabled. Costs ~$0.50 extra per attempt but converts dead briefs into live ones.

---

## Cost-quality trade-off summary

| Pass | Today | With Tier 1 | With Tier 1+2 | Maxed (Tier 1+2+3) |
|---|---|---|---|---|
| Avg sources / brief | 8 | 14 | 18 | 24 |
| Thin-rate (< 5 sources) | ~25% | ~10% | ~5% | ~2% |
| Avg cost / brief | $0.50 | $0.65 | $0.85 | $1.40 |
| Time / brief | 90s | 130s | 180s | 240s |

Tier 1 is the obvious investment — 60% reduction in thin-rate for +30% cost and +45% time. Tier 2 chips away at the long tail at modest extra cost. Tier 3 is only worth it when the leverage on a single brief is high (a $50K deal worth knowing perfectly about) or for compliance-grade due diligence.

---

## Recommended ship order (engineering prioritization)

1. **Open-questions generator** (#18) — converts thin briefs from useless to useful instantly. Pure prompt change.
2. **Direct-scrape the website** (#2) — biggest source-count win per dollar.
3. **Manual source seeding** (#3) + **AE prior knowledge** (#11) — gives Ryan agency to add what he already knows.
4. **Adaptive query expansion** (#1) + **Adaptive recency** (#6) — covers the thin-footprint case automatically.
5. **GitHub presence** (#4) — the highest-signal new tool for AEC vendors specifically.
6. **Two-pass orchestrator** (#16) + **"Add a source" button** (#21) + **"What we couldn't find" panel** (#22) — composition layer on top.
7. **Crunchbase fallback** (#5) for the long tail of private companies Apollo misses.
8. Everything else as needed.

Items 1–6 are roughly a week of focused work and would lift average brief quality on Ryan's pipeline meaningfully.
