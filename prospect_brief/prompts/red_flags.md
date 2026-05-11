# Red Flags allowlist (enforced in code, documented here for reviewers)

The Red Flags section is the highest-risk part of the brief. A confidently wrong "rumor" of a layoff or lawsuit can torpedo a deal and create legal exposure. The pipeline enforces a strict allowlist on what can appear there.

## Allowed source types for Red Flags

A fact may appear in the Red Flags section ONLY if its source meets one of these criteria:

1. SEC filing (10-K, 10-Q, 8-K, S-1, DEF 14A, etc.) — `source_type ∈ {10-K, 10-Q, 8-K, regulatory_filing}`
2. Court filing on PACER or state court docket — `source_type == court_filing`
3. Regulatory filing (FTC, FDA, EPA, etc.) — `source_type == regulatory_filing`
4. Official press release from the company's own domain — `source_type == press_release` AND `publisher_domain == company_domain`
5. Named-byline reporting from a major outlet — `source_type == news_article` AND `publisher ∈ ALLOWLIST` AND `byline is not null`

The major outlet allowlist is defined in `pipeline/config.py` (`MAJOR_OUTLET_ALLOWLIST`). It includes Reuters, Bloomberg, WSJ, NYT, FT, AP, CNBC, Axios, The Information, and a small number of trade publications. Aggregator sites, SEO blogs, Reddit, Twitter/X, and LinkedIn opinion posts are NOT allowed.

## Categories of fact that can land in Red Flags

- `litigation_or_regulatory` (any)
- `financial_signals` where `metric ∈ {layoffs, restructuring, guidance}` AND `direction ∈ {down, flat}`
- `leadership_changes` where `change_type == departed` AND the person is C-suite (CEO, CFO, COO, CTO, CRO) AND was in role < 2 years (sudden departures only)

## What is NEVER allowed in Red Flags

- Anonymous reporting
- "Sources tell us" / "according to people familiar with the matter" without a byline
- Reddit threads, anonymous Glassdoor reviews, anonymous Blind posts
- LinkedIn opinion posts (even from named accounts)
- Aggregator content (Yahoo Finance article body, Seeking Alpha author posts unless verified PRO+)
- Inferences from job postings ("they're laying off because they're not hiring") — speculative
- Stock price commentary unless from a primary financial data source (and it must be presented as price action, not as causal claim)

## If nothing meets the bar

The brief writes one line: "No public red flags identified meeting the source-allowlist bar." This is the correct outcome when the company is quiet. Do not pad.
