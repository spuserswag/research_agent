"""Verifier — the layer that catches hallucinated quotes.

For every fact extracted from any source:
  1. Normalize quote and source text (lowercase, collapse whitespace).
  2. Substring-match the quote against the source text.
  3. If it doesn't match, the fact is stripped and added to verifier_log.

Then assigns confidence tiers:
  - confirmed:        ≥1 primary source (filing | press_release | earnings_call)
                      AND quote check passed
  - corroborated:     ≥2 independent sources (different publisher_domains)
                      asserting the same fact_kind + key
  - single_signal:    1 source, not primary
  - inferred:         not produced by this pipeline by design (writer drops them)

Also:
  - Recency tag: any fact whose source is older than `RECENCY[source_type]` is
    marked stale=True.
  - Red Flag gate: facts intended for the Red Flags section are filtered to
    the source-allowlist defined in config.RED_FLAG_ALLOWED_SOURCE_TYPES, with
    extra rules for news_article (must have byline AND be on
    MAJOR_OUTLET_ALLOWLIST).
"""

from __future__ import annotations
import logging
import re
from datetime import datetime, timezone, date, timedelta
from typing import Dict, List, Tuple
from urllib.parse import urlparse

from .schema import (
    Source, SourceExtraction, VerifiedFact, VerifiedFacts,
    VerifierLog, ConfidenceTier,
)
from . import config

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Quote normalization + substring check
# ---------------------------------------------------------------------------

_WS_RE = re.compile(r"\s+")
_PUNCT_TO_DROP_RE = re.compile(r"[“”‘’]")  # smart quotes


def normalize(text: str) -> str:
    if not text:
        return ""
    text = _PUNCT_TO_DROP_RE.sub('"', text)
    text = text.lower()
    text = _WS_RE.sub(" ", text).strip()
    return text


def quote_appears(quote: str, source_text: str) -> bool:
    if not quote or not source_text:
        return False
    q = normalize(quote)
    t = normalize(source_text)
    if q in t:
        return True
    # Try without surrounding quotation marks
    q_inner = q.strip('"\'')
    return q_inner in t


# ---------------------------------------------------------------------------
# Per-attribute validators for company_profile facts.
#
# The base substring check verifies that the *quote* is in the source. It does
# NOT verify that the *structured value* attached to the quote is supported by
# the quote. Without per-attribute rules, the model produces things like:
#   - founded_year=1983, quote="40 years now"   (math hallucination)
#   - certifications=Construction, quote="1542"  (SIC code misclassified)
#   - employee_count_range=31, quote="…31 permitted projects" (wrong meaning)
# These functions each return (ok, reason) for a single (attribute, value, quote)
# triple. False causes the fact to be stripped with the reason logged.
# ---------------------------------------------------------------------------

_FOUR_DIGIT_YEAR_RE = re.compile(r"\b(1[89]\d{2}|20\d{2})\b")
_CERT_KEYWORDS = (
    "leed", "osha", "iso", "asme", "asce", "agc", "abc",
    "certified", "certification", "accredited", "license", "licensed",
)
_HEADCOUNT_CONTEXT = (
    "employee", "staff", "team", "people", "headcount", "workforce",
    "personnel", "associate", "worker", "fte",
)
_REVENUE_CONTEXT = (
    "revenue", "sales", "turnover", "income", "annual", "$", "million",
    "billion", "m revenue", "b revenue",
)

# Words that have to appear in the QUOTE for a founded_year fact to be
# accepted — guards against the model picking up a 4-digit year that
# happens to be in the source text (employment date, license issue date,
# document date) and labeling it as the founding year.
_FOUNDING_CONTEXT = (
    "founded", "since", "established", "incorporated", "founding",
    "inception", "formed", "started in", "began in", "opened",
    "operating since", "in business since",
)

# Words that have to appear in the QUOTE for an ownership_structure fact
# to be accepted. "Public Company" alone is LinkedIn UI metadata noise —
# requiring a corroborating word ("traded", "publicly", etc.) prevents it
# from polluting the brief.
_OWNERSHIP_CONTEXT = (
    "private", "privately", "publicly", "traded", "owned", "subsidiary",
    "holdings", "esop", "employee-owned", "family-owned", "family owned",
    "private equity", "venture-backed", "vc-backed", "bootstrapped",
)

# Words that have to appear in the QUOTE for a headquarters fact to be
# accepted. Bare addresses (e.g. "975 Morrison Drive, Charleston, SC")
# alone are not enough — many companies list multiple addresses in
# footers and the primary is usually distinguished by language like
# "headquartered" or "main office". Without that, treat the address as
# office_locations, not HQ.
_HQ_INDICATORS = (
    "headquarter", "headquartered",
    "main office", "principal office", "corporate office",
    "primary office", "primary location",
    "based in", "based out of",
    "global headquarters", "company headquarters",
    "head office",
    "located in",          # weaker but common phrasing
)

# Phrases indicating an address is a SECONDARY office (not HQ).
# If any of these appear in the quote, the headquarters extraction
# is rejected — the address is an office_locations, not the HQ.
_SECONDARY_OFFICE_MARKERS = (
    "second office", "additional office", "satellite office",
    "branch office", "regional office", "field office",
    "another location", "additional location",
    "second location",
)

# Reseller / partnership patterns. If the quote contains any of these,
# the model is likely describing third-party products being supplied,
# not the company's own services. We drop services_offered / specialties
# extractions whose quote includes these.
_RESELLER_PATTERNS = (
    # Use root forms so all conjugations match: "resell", "resells",
    # "reseller", "reselling" all matched by "resell". Same for the others.
    "supplie",         # supplies, supplied, supplier, supplying
    "resell",          # resell, resells, reseller, reselling
    "distribut",       # distributes, distributor, distributing
    "powered by",
    "and other ",      # "PortalCam and other XGRIDS scanning solutions"
    "in partnership with",
)

# Federal-contractor ID format checks.
_CAGE_RE = re.compile(r"^[A-Z0-9]{5}$", re.IGNORECASE)
_UEI_RE = re.compile(r"^[A-Z0-9]{12}$", re.IGNORECASE)
_NAICS_RE = re.compile(r"\b\d{6}\b")          # 6-digit NAICS code

# Throughput needs both a number and a unit word.
_THROUGHPUT_UNITS = (
    "scan", "scans", "site", "sites", "project", "projects",
    "deployment", "deployments", "install", "installs",
    "patient", "patients", "transaction", "transactions",
    "user", "users", "customer", "customers",
    "square feet", "sq ft", "sqft", "acres", "miles",
    "buildings", "units", "rooms", "events",
)

# Phrases that indicate a quote is describing personal-employment history,
# not a client relationship. Used to reject notable_clients extractions
# that pull in a previous company an exec founded or worked at.
_PERSONAL_HISTORY_MARKERS = (
    "founder of",
    "co-founder of",
    "founded ",     # "founded DroneLeaf"
    "previously at",
    "previously of",
    "former at",
    "former cto", "former ceo", "former coo", "former cfo",
    "ex-",
    "before founding",
    "before joining",
    "left to start",
    "spun out from",
    "alum of", "alumna of", "alumnus of",
)

# Company-level company_profile attributes that should NEVER be extracted
# from a personal LinkedIn profile (linkedin.com/in/...). These describe
# the company, not the person — and a personal profile reflects the
# PERSON's location/role/specialty, not the COMPANY's.
_COMPANY_LEVEL_ATTRS_BLOCKED_ON_PERSONAL_PROFILES = {
    "headquarters",
    "office_locations",
    "primary_markets",
    "services_offered",
    "specialties",
    "mission_statement",
    "stated_values",
    "ownership_structure",
    "employee_count_range",
    "annual_revenue_range",
    "industry_certifications",
    "founded_year",
    "operational_throughput",
    "technology_stack",
    "notable_clients",
    "awards_recognition",
    "community_involvement",
    "cage_code", "uei", "naics_codes",
}


def _value_tokens_in_quote(value: str, quote: str) -> bool:
    """At least 60% of the value's content tokens must appear in the quote."""
    norm_q = normalize(quote)
    tokens = [t for t in re.split(r"[\s,/]+", value.lower()) if len(t) > 2]
    if not tokens:
        return False
    hits = sum(1 for t in tokens if t in norm_q)
    return (hits / len(tokens)) >= 0.6


def validate_leadership_change(person: str, role: str, quote: str) -> tuple[bool, str]:
    """For leadership_changes: the person's name must appear in the quote.

    Catches cases like attributing "Bobby Brantley — Business Development"
    to a quote that says only "Business Development at Crowder Construction
    Company" — the quote IS in the source, but it doesn't actually support
    the person/role tuple we're claiming.

    Strict rule: the FIRST name must appear as a token in the quote. Last
    name alone isn't enough because surnames frequently overlap with
    company names (e.g. "Dan Brantley" attributed to "Owner, Brantley
    Construction and Landscaping" — last name "Brantley" matches but only
    because it's part of a different company's name).
    """
    if not person:
        return False, "person field empty"
    norm_q = normalize(quote)
    norm_p = normalize(person)
    if norm_p in norm_q:
        return True, ""
    # Token-level check: first name (or any non-surname token > 2 chars)
    # must appear as a whole-word match.
    tokens = [t for t in norm_p.split() if len(t) > 2]
    if not tokens:
        return False, "person field has no usable tokens"
    first_name = tokens[0]
    # Whole-word match — avoid "dan" matching inside "danger" etc.
    if re.search(rf"\b{re.escape(first_name)}\b", norm_q):
        return True, ""
    # Nickname / full-name prefix match: e.g. person="Daniel Rogers" but
    # quote says "Dan Rogers" (or vice versa). Require either side to be a
    # 3+ char prefix of the other to keep false-positive rate low.
    quote_tokens = re.findall(r"\b\w+\b", norm_q)
    for t in quote_tokens:
        if len(t) >= 3 and (
            first_name.startswith(t) or t.startswith(first_name)
        ):
            return True, ""
    return False, f"first name {first_name!r} not present in quote"


def validate_company_profile(attribute: str, value: str, quote: str) -> tuple[bool, str]:
    """Stricter check for company_profile: the structured value must actually
    be supported by the verbatim quote — not just plausibly inferred."""
    norm_q = normalize(quote)
    norm_v = normalize(value)

    if attribute == "founded_year":
        # Value must be a 4-digit year that literally appears in the quote.
        years_in_value = _FOUR_DIGIT_YEAR_RE.findall(norm_v)
        if not years_in_value:
            return False, "founded_year value is not a 4-digit year"
        if years_in_value[0] not in norm_q:
            return False, f"year {years_in_value[0]} not present in quote"
        # The quote must actually be about founding — not just contain a year
        # that happens to be a license issuance, employment date, etc.
        if not any(ctx in norm_q for ctx in _FOUNDING_CONTEXT):
            return False, ("year present in quote but quote lacks "
                           "founding-context word (founded/since/established/…)")
        return True, ""

    if attribute == "headquarters":
        # If the quote names a secondary office, this is office_locations,
        # not HQ. Drop.
        if any(m in norm_q for m in _SECONDARY_OFFICE_MARKERS):
            return False, ("quote names a secondary/satellite office — "
                           "should be office_locations, not headquarters")
        # Require a primary-location indicator. Without one, an address-only
        # quote is ambiguous (which of multiple footer addresses is HQ?).
        if not any(ind in norm_q for ind in _HQ_INDICATORS):
            return False, ("HQ quote lacks primary-location indicator "
                           "(headquartered/based in/main office/etc.). "
                           "If only addresses appear, extract as "
                           "office_locations instead.")
        return _value_tokens_in_quote(value, quote), \
               "HQ value not present in quote"

    if attribute == "ownership_structure":
        # Reject "Public Company" alone — LinkedIn UI metadata noise.
        # Require a real ownership-class keyword in the quote.
        if not any(kw in norm_q for kw in _OWNERSHIP_CONTEXT):
            return False, ("ownership quote lacks class word "
                           "(private/publicly/traded/owned/subsidiary/…)")
        # Bare "public company" / "private company" with no other corroboration
        # is too thin — require either a richer phrase or a specific qualifier.
        if norm_v in {"public company", "public", "private company", "private"}:
            corroborator = ("publicly traded", "privately held",
                            "publicly listed", "private equity",
                            "wholly owned", "subsidiary of",
                            "nyse", "nasdaq", "lse", "stock exchange")
            if not any(c in norm_q for c in corroborator):
                return False, ("bare 'public/private company' with no "
                               "corroborator (publicly traded / privately held / "
                               "ticker / parent company)")
        return _value_tokens_in_quote(value, quote), \
               "ownership value not present in quote"

    if attribute == "employee_count_range":
        if not any(kw in norm_q for kw in _HEADCOUNT_CONTEXT):
            return False, "headcount quote lacks employee/staff/team context"
        # The headcount-class word is required; the actual number from the
        # value must also appear in the quote. _value_tokens_in_quote drops
        # short tokens like "50" so we check numeric tokens explicitly.
        nums = re.findall(r"\d+", norm_v)
        if nums and not any(n in norm_q for n in nums):
            return False, "headcount number not present in quote"
        return True, ""

    if attribute == "annual_revenue_range":
        if not any(kw in norm_q for kw in _REVENUE_CONTEXT):
            return False, "revenue quote lacks revenue/sales/$ context"
        return _value_tokens_in_quote(value, quote), \
               "revenue value not present in quote"

    if attribute == "industry_certifications":
        # Quote must mention an actual certifying body or the word certified.
        if not any(kw in norm_q for kw in _CERT_KEYWORDS):
            return False, "certifications quote lacks recognized cert keyword"
        return _value_tokens_in_quote(value, quote), \
               "certification value not present in quote"

    if attribute in ("services_offered", "specialties"):
        # Drop facts where the quote describes RESELLING / PARTNERSHIP-MEDIATED
        # third-party products (e.g., "supplies the PortalCam and other
        # XGRIDS scanning solutions" → those are XGRIDS' products, not ours).
        for pattern in _RESELLER_PATTERNS:
            if pattern in norm_q:
                return False, (f"quote contains reseller/partner pattern "
                               f"{pattern!r} — likely third-party products, "
                               f"not own services")
        # Otherwise generic value-tokens-in-quote rule.
        if not _value_tokens_in_quote(value, quote):
            return False, "value tokens not supported by quote"
        return True, ""

    if attribute == "technology_stack":
        # Tech stack EXPLICITLY may name third-party tools (XGRIDS, AWS,
        # Snowflake, Revit) — that's the point of a stack. So we skip the
        # reseller-pattern check here. Just require the value tokens to be
        # present in the quote.
        if not _value_tokens_in_quote(value, quote):
            return False, "tech stack value tokens not supported by quote"
        return True, ""

    if attribute == "cage_code":
        # CAGE codes are exactly 5 alphanumeric chars, e.g. "9DZZ0".
        v_clean = norm_v.replace(" ", "").upper()
        if not _CAGE_RE.match(v_clean):
            return False, f"value {value!r} does not match CAGE format (5 alphanumeric)"
        if v_clean.lower() not in norm_q.replace(" ", ""):
            return False, "CAGE code not present in quote"
        return True, ""

    if attribute == "uei":
        # UEI is exactly 12 alphanumeric chars, e.g. "PM9THMDC1DV7".
        v_clean = norm_v.replace(" ", "").upper()
        if not _UEI_RE.match(v_clean):
            return False, f"value {value!r} does not match UEI format (12 alphanumeric)"
        if v_clean.lower() not in norm_q.replace(" ", ""):
            return False, "UEI not present in quote"
        return True, ""

    if attribute == "naics_codes":
        # Must contain at least one 6-digit number, and that number must be
        # in the quote.
        codes = _NAICS_RE.findall(norm_v)
        if not codes:
            return False, "NAICS value contains no 6-digit code"
        if not any(c in norm_q for c in codes):
            return False, "no NAICS code present in quote"
        return True, ""

    if attribute == "operational_throughput":
        # Need a number and a unit word in the quote.
        nums = re.findall(r"\d[\d,]*", norm_q)
        if not nums:
            return False, "throughput quote contains no number"
        if not any(u in norm_q for u in _THROUGHPUT_UNITS):
            return False, "throughput quote lacks a unit word (scans/sites/projects/sq ft/etc.)"
        # Value should reference at least one of the same numbers.
        value_nums = re.findall(r"\d[\d,]*", norm_v)
        if value_nums and not any(n in nums for n in value_nums):
            return False, "throughput value number not in quote"
        return True, ""

    # Generic rule for the rest (HQ, offices, mission, etc.):
    # the value's content tokens must mostly appear in the quote.
    if not _value_tokens_in_quote(value, quote):
        return False, f"value tokens not supported by quote"
    return True, ""


# ---------------------------------------------------------------------------
# Recency
# ---------------------------------------------------------------------------

def is_stale(source: Source) -> bool:
    if not source.publish_date:
        return False
    window = config.RECENCY.get(source.type, timedelta(days=365))
    age = date.today() - source.publish_date
    return age > window


# ---------------------------------------------------------------------------
# Red Flag gate
# ---------------------------------------------------------------------------

def red_flag_eligible(source: Source, company_domain: str = "") -> bool:
    if source.type not in config.RED_FLAG_ALLOWED_SOURCE_TYPES:
        return False
    host = (urlparse(source.url).hostname or "").lower().lstrip("www.")
    if any(banned in host for banned in config.RED_FLAG_BANNED_DOMAINS):
        return False
    if source.type == "news_article":
        if not source.byline:
            return False
        if not any(host.endswith(d) for d in config.MAJOR_OUTLET_ALLOWLIST):
            return False
    if source.type == "press_release" and company_domain:
        if company_domain.lower().lstrip("www.") not in host:
            return False
    return True


# ---------------------------------------------------------------------------
# Tiering — collapse facts across sources, assign tier
# ---------------------------------------------------------------------------

def _fact_key(fact_kind: str, payload: dict) -> Tuple:  # noqa: C901
    """Stable de-dup key per fact category.

    Two facts with the same (fact_kind, key) are treated as the same fact
    asserted by their respective sources. Used to count corroboration.
    """
    if fact_kind == "company_profile":
        return (fact_kind, payload.get("attribute", ""),
                payload.get("value", "").lower())
    if fact_kind == "leadership_changes":
        return (fact_kind, payload.get("person", "").lower(),
                payload.get("change_type", ""))
    if fact_kind == "financial_signals":
        return (fact_kind, payload.get("metric", ""),
                payload.get("period", ""))
    if fact_kind == "litigation_or_regulatory":
        return (fact_kind, payload.get("matter_short_name", "").lower())
    if fact_kind == "funding_events":
        return (fact_kind, payload.get("event_type", ""),
                str(payload.get("event_date", "")))
    if fact_kind == "product_launches":
        return (fact_kind, payload.get("product_name", "").lower())
    if fact_kind == "customer_or_partnership":
        return (fact_kind, payload.get("counterparty", "").lower(),
                payload.get("type", ""))
    if fact_kind == "exec_statements":
        return (fact_kind, payload.get("speaker_name", "").lower(),
                payload.get("verbatim_quote", "")[:40].lower())
    if fact_kind == "hiring_signals":
        return (fact_kind, payload.get("function", ""),
                str(payload.get("as_of_date", "")))
    return (fact_kind, str(payload))


PRIMARY_TYPES = {
    "10-K", "10-Q", "8-K",
    "press_release", "earnings_call_transcript",
    "court_filing", "regulatory_filing", "investor_deck",
}


def verify(
    extractions: List[SourceExtraction],
    sources: List[Source],
    *,
    company: str,
    ticker: str | None,
    ae: str,
    meeting_date: date,
    coverage_window_start: date,
    coverage_window_end: date,
    gaps: List[str],
) -> VerifiedFacts:
    by_id: Dict[str, Source] = {s.id: s for s in sources}

    # Step 1: substring-check every quote AND drop out-of-window sources/facts.
    accepted: List[Tuple[str, dict, Source]] = []
    stripped: List[dict] = []
    quotes_checked = 0

    fact_kinds = [
        "leadership_changes", "funding_events", "exec_statements",
        "hiring_signals", "financial_signals", "product_launches",
        "customer_or_partnership", "litigation_or_regulatory",
        "company_profile",
    ]

    # The "primary date" field per fact kind — used for per-fact recency check.
    # company_profile has no date field — these facts are about what the company
    # IS, not what it's doing right now. Recency doesn't apply.
    primary_date_field = {
        "leadership_changes": "effective_date",
        "funding_events": "event_date",
        "exec_statements": "statement_date",
        "hiring_signals": "as_of_date",
        "financial_signals": "as_of_date",
        "product_launches": "launch_date",
        "customer_or_partnership": "announced_date",
        "litigation_or_regulatory": "filed_date",
        "company_profile": None,    # exempt from recency
    }

    for ex in extractions:
        src = by_id.get(ex.source_id)
        if not src or not src.text:
            continue

        # Hard recency drop: if the source itself was published before the
        # coverage window starts, time-sensitive facts are dropped. The [stale]
        # tag is for borderline cases; this is for "not current at all".
        # company_profile facts are EXEMPT — these are stable business info
        # (founded year, HQ, services) that don't go stale.
        source_out_of_window = (
            src.publish_date is not None and src.publish_date < coverage_window_start
        )

        for kind in fact_kinds:
            is_stable_kind = (kind == "company_profile")
            for fact in getattr(ex, kind):
                quotes_checked += 1
                payload = fact.model_dump(mode="json")

                # Source-level recency drop, except for stable kinds.
                if source_out_of_window and not is_stable_kind:
                    stripped.append({
                        "reason": "source_out_of_coverage_window",
                        "fact_kind": kind,
                        "source_id": src.id,
                        "source_publish_date": src.publish_date.isoformat(),
                        "quote": fact.verbatim_quote,
                    })
                    continue

                # Per-fact recency: if the fact's own date is before the
                # coverage window, drop it. (Source publish date is necessary
                # but not sufficient — a 2026 article can cite a 2018 event.)
                date_field = primary_date_field.get(kind)
                fact_date_raw = payload.get(date_field) if date_field else None
                if fact_date_raw and not is_stable_kind:
                    try:
                        fact_date = date.fromisoformat(str(fact_date_raw))
                    except ValueError:
                        fact_date = None
                    if fact_date and fact_date < coverage_window_start:
                        stripped.append({
                            "reason": "fact_date_out_of_window",
                            "fact_kind": kind,
                            "source_id": src.id,
                            "fact_date": fact_date.isoformat(),
                            "quote": fact.verbatim_quote,
                        })
                        continue

                if not quote_appears(fact.verbatim_quote, src.text):
                    stripped.append({
                        "reason": "quote_not_in_source",
                        "fact_kind": kind,
                        "source_id": src.id,
                        "quote": fact.verbatim_quote,
                    })
                    continue

                # Extra rigor for company_profile: the value must actually be
                # supported by the quote, not inferred from it. This is what
                # catches "founded 1983" / "40 years now" — quote is in source
                # but value is fabricated.
                if kind == "company_profile":
                    attr = payload.get("attribute", "")
                    val = payload.get("value", "")
                    norm_company = (company or "").strip().lower()
                    norm_val = (val or "").strip().lower()
                    norm_quote = (fact.verbatim_quote or "").lower()

                    # Block company-level facts from LinkedIn personal profiles.
                    is_personal_li = (
                        src.type == "linkedin_profile"
                        and "/in/" in (src.url or "").lower()
                    )
                    if is_personal_li and attr in \
                            _COMPANY_LEVEL_ATTRS_BLOCKED_ON_PERSONAL_PROFILES:
                        stripped.append({
                            "reason": "company_attr_from_personal_linkedin_profile",
                            "fact_kind": kind,
                            "source_id": src.id,
                            "attribute": attr,
                            "value": val,
                            "quote": fact.verbatim_quote,
                        })
                        continue

                    # Block services/specialties/markets where value equals
                    # the company name (or is a strict substring of it).
                    if attr in ("services_offered", "specialties",
                                "primary_markets") and norm_company:
                        if norm_val == norm_company or (
                            norm_val and norm_val in norm_company
                            and len(norm_val) > 4
                        ):
                            stripped.append({
                                "reason": "value_equals_company_name",
                                "fact_kind": kind,
                                "source_id": src.id,
                                "attribute": attr,
                                "value": val,
                                "quote": fact.verbatim_quote,
                            })
                            continue

                    # Block notable_clients facts whose quote is describing
                    # an exec's personal employment history rather than an
                    # actual QRC ↔ client relationship.
                    if attr == "notable_clients":
                        if any(m in norm_quote for m in _PERSONAL_HISTORY_MARKERS):
                            stripped.append({
                                "reason": "notable_clients_from_personal_history",
                                "fact_kind": kind,
                                "source_id": src.id,
                                "value": val,
                                "quote": fact.verbatim_quote,
                            })
                            continue

                    ok, reason = validate_company_profile(
                        attr, val, fact.verbatim_quote,
                    )
                    if not ok:
                        stripped.append({
                            "reason": f"value_not_supported_by_quote: {reason}",
                            "fact_kind": kind,
                            "source_id": src.id,
                            "attribute": attr,
                            "value": val,
                            "quote": fact.verbatim_quote,
                        })
                        continue

                # Same idea for leadership_changes: the person name must
                # actually be in the quote, not just inferred from the URL.
                if kind == "leadership_changes":
                    ok, reason = validate_leadership_change(
                        payload.get("person", ""),
                        payload.get("role", ""),
                        fact.verbatim_quote,
                    )
                    if not ok:
                        stripped.append({
                            "reason": f"value_not_supported_by_quote: {reason}",
                            "fact_kind": kind,
                            "source_id": src.id,
                            "person": payload.get("person"),
                            "role": payload.get("role"),
                            "quote": fact.verbatim_quote,
                        })
                        continue

                accepted.append((kind, payload, src))

    # Step 2: collapse by fact_key, assign tier.
    grouped: Dict[Tuple, List[Tuple[str, dict, Source]]] = {}
    for kind, payload, src in accepted:
        grouped.setdefault(_fact_key(kind, payload), []).append((kind, payload, src))

    verified: List[VerifiedFact] = []
    for key, members in grouped.items():
        kind = members[0][0]
        # Pick "best" payload: prefer the one with the most filled fields.
        members_sorted = sorted(
            members, key=lambda m: sum(1 for v in m[1].values() if v), reverse=True
        )
        kind, payload, _ = members_sorted[0]
        source_ids = [m[2].id for m in members]
        sources_for_fact = [m[2] for m in members]

        # Tier
        publishers = {(urlparse(s.url).hostname or "").lower() for s in sources_for_fact}
        any_primary = any(s.type in PRIMARY_TYPES for s in sources_for_fact)
        if any_primary:
            tier = ConfidenceTier.confirmed
        elif len(publishers) >= 2:
            tier = ConfidenceTier.corroborated
        else:
            tier = ConfidenceTier.single_signal

        # Stale flag — if all backing sources are stale. company_profile facts
        # are stable info (founding year doesn't go stale), so never marked.
        all_stale = (kind != "company_profile") and all(
            is_stale(s) for s in sources_for_fact
        )

        verified.append(VerifiedFact(
            fact_kind=kind,
            payload=payload,
            source_ids=source_ids,
            tier=tier,
            stale=all_stale,
        ))

    log.info(
        "verifier: %d quotes checked, %d passed, %d stripped, %d unique facts",
        quotes_checked, len(accepted), len(stripped), len(verified),
    )

    return VerifiedFacts(
        company=company,
        ticker=ticker,
        ae=ae,
        meeting_date=meeting_date,
        generated_at=datetime.now(timezone.utc),
        coverage_window_start=coverage_window_start,
        coverage_window_end=coverage_window_end,
        sources=sources,
        facts=verified,
        gaps=gaps,
        verifier_log=VerifierLog(
            quotes_checked=quotes_checked,
            quotes_passed=len(accepted),
            stripped=stripped,
        ),
    )
