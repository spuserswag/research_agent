"""Static configuration: recency windows, source allowlists, model names.

Keep this file boring. Anything that's a knob lives here so the pipeline
modules stay declarative.
"""

from __future__ import annotations
from datetime import timedelta

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

# OpenAI models. gpt-4o-mini is the cheap/fast default for the extractor.
# Both stages support JSON-mode (response_format={"type": "json_object"}).
EXTRACTOR_MODEL = "gpt-4o-mini"     # structured extraction per source
WRITER_MODEL = "gpt-4o"             # final brief rendering (opt-in only)
# Verifier is rule-based (substring + heuristics), no model required.

EXTRACTOR_MAX_TOKENS = 4096
WRITER_MAX_TOKENS = 4096

# ---------------------------------------------------------------------------
# Recency windows — anything older than these gets a [stale] tag
# ---------------------------------------------------------------------------

RECENCY = {
    "news_article": timedelta(days=90),
    "press_release": timedelta(days=270),
    "earnings_call_transcript": timedelta(days=120),
    "exec_interview": timedelta(days=365),
    "job_posting": timedelta(days=30),
    "linkedin_post": timedelta(days=180),
    "company_blog": timedelta(days=270),
    "career_page": timedelta(days=60),
    "linkedin_profile": timedelta(days=730),    # profiles change slowly
    "industry_database": timedelta(days=730),
    "user_seeded": timedelta(days=730),
    # filings live longer — most recent only
    "10-K": timedelta(days=400),
    "10-Q": timedelta(days=120),
    "8-K": timedelta(days=120),
    "court_filing": timedelta(days=730),
    "regulatory_filing": timedelta(days=730),
}

# Hard cutoff: any source older than this is dropped entirely.
HARD_CUTOFF = timedelta(days=730)

# ---------------------------------------------------------------------------
# Quote rules
# ---------------------------------------------------------------------------

MAX_QUOTE_WORDS = 15
# Verifier substring match is normalized: lowercased, whitespace collapsed.
# A quote passes if the normalized quote appears as a substring of the
# normalized source text.
QUOTE_NORMALIZE = True

# ---------------------------------------------------------------------------
# Red Flags source allowlist
# ---------------------------------------------------------------------------

RED_FLAG_ALLOWED_SOURCE_TYPES = {
    "10-K", "10-Q", "8-K",
    "court_filing", "regulatory_filing", "press_release", "news_article",
}

# News articles must come from one of these publishers AND have a named byline.
MAJOR_OUTLET_ALLOWLIST = {
    "reuters.com", "bloomberg.com", "wsj.com", "nytimes.com", "ft.com",
    "apnews.com", "cnbc.com", "axios.com", "theinformation.com",
    "barrons.com", "businessinsider.com",
    # trade pubs (selective — extend per industry)
    "techcrunch.com", "theverge.com", "stat news.com", "fiercehealthcare.com",
    "law360.com", "reuters.com",
}

# Hard ban for Red Flags (even if other rules would let them through)
RED_FLAG_BANNED_DOMAINS = {
    "reddit.com", "x.com", "twitter.com", "glassdoor.com", "blind.com",
    "medium.com", "substack.com",
}

# ---------------------------------------------------------------------------
# Forbidden filler phrases (stripped/flagged in writer output)
# ---------------------------------------------------------------------------

FORBIDDEN_PHRASES = [
    "digital transformation",
    "operational efficiency",
    "innovation-focused",
    "looking to scale",
    "leveraging synergies",
    "best-in-class",
    "industry-leading",
    "it seems that",
    "it appears that",
    "it is likely that",
    "robust",
    "best of breed",
]

# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

USER_AGENT = (
    "prospect_brief/0.1 (sales-intelligence; contact: ops@example.com)"
)
HTTP_TIMEOUT_SECONDS = 20
