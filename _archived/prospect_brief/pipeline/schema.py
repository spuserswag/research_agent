"""Typed schema — the contract between every stage of the pipeline.

Pydantic v2. The extractor returns `SourceExtraction`. The verifier returns
`VerifiedFacts`. The renderer consumes `VerifiedFacts` and produces a
`Brief`. The pipeline persists everything to disk as JSON for audit.
"""

from __future__ import annotations
from datetime import date, datetime
from enum import Enum
from typing import Any, List, Optional, Literal

from pydantic import BaseModel, Field, field_validator

from . import config


# ---------------------------------------------------------------------------
# Lenient coercers — small helpers used by `mode="before"` validators so the
# extractor LLM's natural output (comma-strings, free-form dates) parses
# cleanly instead of failing whole sources.
# ---------------------------------------------------------------------------

def _coerce_str_to_list(v: Any) -> Any:
    """Accept a comma-separated string in place of a list of strings."""
    if isinstance(v, str):
        return [t.strip() for t in v.split(",") if t.strip()]
    return v


_DATE_FORMATS = (
    "%Y-%m-%d",
    "%B %d, %Y",      # "January 31, 2020"
    "%b %d, %Y",      # "Jan 31, 2020"
    "%m/%d/%Y",
    "%d %B %Y",
    "%Y/%m/%d",
)


def _coerce_loose_date(v: Any) -> Any:
    """Accept several common date string formats, including those gpt-4o-mini
    likes to emit (e.g. 'January 31, 2020'). Returns ISO date string that
    Pydantic's date type can parse, or passes through unchanged."""
    if not isinstance(v, str):
        return v
    s = v.strip()
    if not s:
        return None
    # ISO-with-time
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        pass
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    # Year-only ("2025") — assume Jan 1
    if s.isdigit() and len(s) == 4:
        return f"{s}-01-01"
    return v   # let pydantic complain if truly unparseable


# ---------------------------------------------------------------------------
# Source
# ---------------------------------------------------------------------------

SourceType = Literal[
    "10-K", "10-Q", "8-K",
    "press_release",
    "earnings_call_transcript",
    "exec_interview",
    "news_article",
    "job_posting",
    "court_filing",
    "regulatory_filing",
    "linkedin_post",
    "linkedin_profile",          # leadership profiles via DDG snippets
    "company_blog",
    "investor_deck",
    "career_page",
    "industry_database",         # BuildZoom, state procurement portals, Dodge, etc.
    "user_seeded",               # URLs supplied via --seed-urls
]


class Source(BaseModel):
    id: str                           # e.g. "S5"
    type: SourceType
    url: str
    publisher: str
    publish_date: Optional[date] = None
    title: str
    accessed_at: datetime
    byline: Optional[str] = None      # required for news_article to pass red-flag gate

    # Populated by fetch.py
    text: Optional[str] = None        # cleaned full text used for extraction + verification


# ---------------------------------------------------------------------------
# Facts (each carries source_id and a verbatim_quote ≤ MAX_QUOTE_WORDS)
# ---------------------------------------------------------------------------

class FactBase(BaseModel):
    source_id: str
    verbatim_quote: str

    @field_validator("verbatim_quote")
    @classmethod
    def quote_word_count(cls, v: str) -> str:
        n = len(v.split())
        if n > config.MAX_QUOTE_WORDS:
            raise ValueError(
                f"verbatim_quote has {n} words; max is {config.MAX_QUOTE_WORDS}"
            )
        return v


class LeadershipChange(FactBase):
    person: str
    role: str
    change_type: Literal["hired", "departed", "promoted", "reassigned"]
    effective_date: Optional[date] = None

    _coerce_eff_date = field_validator("effective_date", mode="before")(_coerce_loose_date)


class FundingEvent(FactBase):
    event_type: Literal["round", "acquisition", "ipo", "divestiture", "secondary"]
    amount_usd_text: Optional[str] = None
    event_date: Optional[date] = None

    _coerce_event_date = field_validator("event_date", mode="before")(_coerce_loose_date)


class ExecStatement(FactBase):
    speaker_name: str
    speaker_title: str
    forum: Literal[
        "earnings_call", "interview", "conference", "blog", "filing", "press_release"
    ]
    statement_date: Optional[date] = None
    topic_tags: List[str] = Field(default_factory=list)

    _coerce_stmt_date = field_validator("statement_date", mode="before")(_coerce_loose_date)
    _coerce_tags = field_validator("topic_tags", mode="before")(_coerce_str_to_list)


class HiringSignal(FactBase):
    function: Literal[
        "eng", "product", "sales", "marketing", "ops", "finance",
        "field_ops", "project_management", "design",   # construction / services
        "clinical", "regulatory",                       # healthcare
        "other",
    ]
    role_count: Optional[int] = None
    window_days: Optional[int] = None
    notable_titles: List[str] = Field(default_factory=list)
    tech_keywords: List[str] = Field(default_factory=list)
    as_of_date: Optional[date] = None

    _coerce_titles = field_validator("notable_titles", mode="before")(_coerce_str_to_list)
    _coerce_tech = field_validator("tech_keywords", mode="before")(_coerce_str_to_list)
    _coerce_asof = field_validator("as_of_date", mode="before")(_coerce_loose_date)


class FinancialSignal(FactBase):
    metric: Literal[
        "revenue", "operating_margin", "free_cash_flow", "guidance",
        "layoffs", "restructuring", "capex"
    ]
    direction: Literal["up", "down", "flat", "unspecified"]
    magnitude_text: Optional[str] = None
    period: Optional[str] = None
    as_of_date: Optional[date] = None

    _coerce_asof = field_validator("as_of_date", mode="before")(_coerce_loose_date)


class ProductLaunch(FactBase):
    product_name: str
    launch_date: Optional[date] = None
    stated_purpose_quote: Optional[str] = None  # may equal verbatim_quote

    _coerce_launch = field_validator("launch_date", mode="before")(_coerce_loose_date)


class CustomerOrPartnership(FactBase):
    counterparty: str
    type: Literal[
        "customer_win", "customer_loss", "partnership", "integration", "reseller"
    ]
    announced_date: Optional[date] = None

    _coerce_announced = field_validator("announced_date", mode="before")(_coerce_loose_date)


class LitigationOrRegulatory(FactBase):
    matter_short_name: str
    filed_date: Optional[date] = None
    forum: Literal["court", "agency"]
    docket_or_case_number: Optional[str] = None
    status: Optional[str] = None

    _coerce_filed = field_validator("filed_date", mode="before")(_coerce_loose_date)


class CompanyProfile(FactBase):
    """Stable business info — founded year, HQ, services, scale.

    Especially valuable for thin-signal prospects (private regional companies)
    where there's no recent news but the About page carries useful color.
    Recency rules don't apply — these facts are about what the company IS,
    not what it's doing right now.
    """
    attribute: Literal[
        # Identity & scale
        "founded_year",
        "headquarters",
        "office_locations",
        "services_offered",
        "specialties",
        "employee_count_range",
        "annual_revenue_range",
        "industry_certifications",
        "primary_markets",
        # Culture / mission / proof
        "mission_statement",
        "stated_values",
        "notable_clients",
        "awards_recognition",
        "ownership_structure",
        "community_involvement",
        # Federal-contractor identifiers (high-value for B2G prospects)
        "cage_code",
        "uei",
        "naics_codes",
        # Technical / operational depth
        "technology_stack",
        "operational_throughput",
    ]
    value: str   # short value, e.g. "1976", "Charleston, SC", "commercial, churches, distribution centers"


# ---------------------------------------------------------------------------
# Per-source extraction output
# ---------------------------------------------------------------------------

class SourceExtraction(BaseModel):
    source_id: str
    leadership_changes: List[LeadershipChange] = Field(default_factory=list)
    funding_events: List[FundingEvent] = Field(default_factory=list)
    exec_statements: List[ExecStatement] = Field(default_factory=list)
    hiring_signals: List[HiringSignal] = Field(default_factory=list)
    financial_signals: List[FinancialSignal] = Field(default_factory=list)
    product_launches: List[ProductLaunch] = Field(default_factory=list)
    customer_or_partnership: List[CustomerOrPartnership] = Field(default_factory=list)
    litigation_or_regulatory: List[LitigationOrRegulatory] = Field(default_factory=list)
    company_profile: List[CompanyProfile] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Verifier output
# ---------------------------------------------------------------------------

class ConfidenceTier(str, Enum):
    confirmed = "confirmed"
    corroborated = "corroborated"
    single_signal = "single_signal"
    inferred = "inferred"        # filtered out by writer


class VerifiedFact(BaseModel):
    """Wraps any fact-like dict + tier + verifier metadata."""
    fact_kind: str                       # e.g. "leadership_changes"
    payload: dict                        # the fact's serialized fields
    source_ids: List[str]
    tier: ConfidenceTier
    stale: bool = False


class VerifierLog(BaseModel):
    quotes_checked: int
    quotes_passed: int
    stripped: List[dict] = Field(default_factory=list)   # {"reason": ..., "fact": {...}}


class VerifiedFacts(BaseModel):
    company: str
    ticker: Optional[str] = None
    ae: str
    meeting_date: date
    generated_at: datetime
    coverage_window_start: date
    coverage_window_end: date

    sources: List[Source]
    facts: List[VerifiedFact]
    gaps: List[str] = Field(default_factory=list)
    verifier_log: VerifierLog


# ---------------------------------------------------------------------------
# Final brief (markdown blob + structured metadata)
# ---------------------------------------------------------------------------

class Brief(BaseModel):
    markdown: str
    facts: VerifiedFacts
