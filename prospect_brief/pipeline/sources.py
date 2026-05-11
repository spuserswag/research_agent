"""Source discovery.

This module is intentionally narrow: given a company name + ticker, it
produces a list of *candidate* `Source` objects (URL, type, publisher,
title, publish_date if known). The fetch.py module handles actually
pulling the bytes.

Layered approach:
1. Direct adapters for primary sources (SEC EDGAR, company newsroom,
   careers page) — high signal, no API key required.
2. Web search via Tavily (preferred when TAVILY_API_KEY is set) → DDG
   (the `ddgs` library) as fallback. Both keyless options exist.
"""

from __future__ import annotations
import hashlib
import os
import re
import logging
from datetime import datetime, timezone, date, timedelta
from typing import Iterable, List, Optional
from urllib.parse import urlparse

import httpx

from .schema import Source
from . import config

log = logging.getLogger(__name__)


def _stable_id(prefix: str, seed: str) -> str:
    """Deterministic source ID. Python's built-in hash() is salted per
    process, so identical inputs produce different ints across runs — that
    breaks the cache → verify handoff because the cached source_id no
    longer matches the current run's source.id. sha1 is stable."""
    h = hashlib.sha1(seed.encode("utf-8")).hexdigest()[:10]
    return f"{prefix}:{h}"


# ---------------------------------------------------------------------------
# SEC EDGAR — recent filings for a ticker
# ---------------------------------------------------------------------------

EDGAR_SEARCH_URL = "https://www.sec.gov/cgi-bin/browse-edgar"
EDGAR_SUBMISSIONS = "https://data.sec.gov/submissions/CIK{cik}.json"
EDGAR_TICKERS = "https://www.sec.gov/files/company_tickers.json"


def _http() -> httpx.Client:
    return httpx.Client(
        timeout=config.HTTP_TIMEOUT_SECONDS,
        headers={"User-Agent": config.USER_AGENT},
        follow_redirects=True,
    )


def cik_for_ticker(ticker: str) -> Optional[str]:
    """Look up the 10-digit zero-padded CIK for a ticker via the SEC's public map."""
    with _http() as c:
        r = c.get(EDGAR_TICKERS)
        r.raise_for_status()
        data = r.json()
    needle = ticker.upper().strip()
    for row in data.values():
        if row.get("ticker", "").upper() == needle:
            return f"{int(row['cik_str']):010d}"
    return None


def edgar_recent_filings(ticker: str, forms: Iterable[str] = ("10-K", "10-Q", "8-K"),
                        limit_per_form: int = 2) -> List[Source]:
    """Return recent filings as Source candidates. Filing index URLs only — fetch.py
    will follow them to the document text."""
    cik = cik_for_ticker(ticker)
    if not cik:
        return []
    with _http() as c:
        r = c.get(EDGAR_SUBMISSIONS.format(cik=cik))
        r.raise_for_status()
        sub = r.json()
    rec = sub.get("filings", {}).get("recent", {})
    out: List[Source] = []
    counts = {f: 0 for f in forms}
    for i, form in enumerate(rec.get("form", [])):
        if form not in counts or counts[form] >= limit_per_form:
            continue
        accession_raw = rec["accessionNumber"][i]
        accession = accession_raw.replace("-", "")
        primary_doc = rec["primaryDocument"][i]
        filed = rec["filingDate"][i]
        url = (
            f"https://www.sec.gov/Archives/edgar/data/"
            f"{int(cik)}/{accession}/{primary_doc}"
        )
        out.append(Source(
            id=f"EDGAR:{form}:{accession_raw}",
            type=form,                              # type: ignore[arg-type]
            url=url,
            publisher="sec.gov",
            publish_date=date.fromisoformat(filed),
            title=f"{ticker} {form} filed {filed}",
            accessed_at=datetime.now(timezone.utc),
        ))
        counts[form] += 1
    return out


# ---------------------------------------------------------------------------
# Company newsroom + careers (best-effort URL guessing)
# ---------------------------------------------------------------------------

NEWSROOM_PATHS = ["/newsroom", "/news", "/press", "/press-releases", "/blog/news"]
CAREERS_PATHS = ["/careers", "/jobs", "/company/careers"]


def discover_company_pages(domain: str) -> List[Source]:
    """Probe common newsroom/careers paths and return any that 200."""
    out: List[Source] = []
    base = domain.rstrip("/")
    if not base.startswith("http"):
        base = "https://" + base
    with _http() as c:
        for path in NEWSROOM_PATHS:
            url = base + path
            try:
                r = c.head(url)
                if r.status_code == 200:
                    out.append(Source(
                        id=f"NEWSROOM:{urlparse(base).hostname}",
                        type="press_release",
                        url=url,
                        publisher=urlparse(base).hostname or "",
                        title=f"{urlparse(base).hostname} newsroom index",
                        accessed_at=datetime.now(timezone.utc),
                    ))
                    break
            except Exception:
                continue
        for path in CAREERS_PATHS:
            url = base + path
            try:
                r = c.head(url)
                if r.status_code == 200:
                    out.append(Source(
                        id=f"CAREERS:{urlparse(base).hostname}",
                        type="career_page",
                        url=url,
                        publisher=urlparse(base).hostname or "",
                        title=f"{urlparse(base).hostname} careers index",
                        accessed_at=datetime.now(timezone.utc),
                    ))
                    break
            except Exception:
                continue
    return out


# ---------------------------------------------------------------------------
# Tavily — preferred search backend when TAVILY_API_KEY is set.
# ---------------------------------------------------------------------------

def _tavily_search(query: str, num: int, *, news_only: bool) -> List[dict]:
    """Search via Tavily. Returns [] on missing dependency, missing key,
    or any error — caller falls back to DDG."""
    api_key = os.environ.get("TAVILY_API_KEY")
    if not api_key:
        return []
    try:
        from tavily import TavilyClient
    except ImportError:
        log.warning("tavily-python not installed; skipping Tavily backend.")
        return []
    try:
        client = TavilyClient(api_key=api_key)
        # `topic="news"` biases the index toward recent reporting; "general"
        # is broader. We use `advanced` depth for better recall on the small
        # private companies that struggle with DDG.
        kwargs = {
            "query": query,
            "max_results": num,
            "search_depth": "advanced",
        }
        if news_only:
            kwargs["topic"] = "news"
        resp = client.search(**kwargs)
    except Exception as e:
        log.warning("tavily search failed (%s): %s", query, e)
        return []

    out: List[dict] = []
    for r in resp.get("results", []) or []:
        url = r.get("url", "")
        if not url:
            continue
        out.append({
            "title": r.get("title", "") or url,
            "url": url,
            "publisher": urlparse(url).hostname or "",
            "date": r.get("published_date"),
            "byline": None,
            # `content` from Tavily is a snippet pulled from the page —
            # equivalent of DDG's `body`. Saves a fetch round-trip later.
            "body": r.get("content", "") or "",
        })
    return out


# ---------------------------------------------------------------------------
# Web search adapter — Tavily preferred → DDG fallback.
# ---------------------------------------------------------------------------

def web_search(query: str, num: int = 10, *, news_only: bool = False) -> List[dict]:
    """Return [{title, url, publisher, date, byline, body}] for `query`.

    Order of preference:
      1. Tavily (if TAVILY_API_KEY is set) — better recall, broader index
      2. DuckDuckGo via the `ddgs` library — keyless fallback

    Returns [] on total failure rather than raising — the pipeline degrades
    gracefully when search is unavailable.
    """
    # ---- Tavily (preferred) ----
    if os.environ.get("TAVILY_API_KEY"):
        results = _tavily_search(query, num=num, news_only=news_only)
        if results:
            return results
        # If Tavily returned [] (rate limit, network), fall through to DDG.

    # ---- DDG fallback ----
    try:
        from ddgs import DDGS  # package: ddgs (formerly duckduckgo-search)
    except ImportError:
        try:
            from duckduckgo_search import DDGS  # legacy package name
        except ImportError:
            log.warning(
                "ddgs not installed — web search disabled. "
                "Run: pip install ddgs"
            )
            return []

    try:
        with DDGS() as ddgs:
            if news_only:
                # ddgs.news returns dicts with: date, title, body, url, source
                raw = list(ddgs.news(query, max_results=num)) or []
                return [
                    {
                        "title": r.get("title", ""),
                        "url": r.get("url", ""),
                        "publisher": r.get("source")
                            or urlparse(r.get("url", "")).hostname or "",
                        "date": r.get("date"),
                        "byline": None,   # ddgs news does not surface bylines
                        "body": r.get("body", ""),
                    }
                    for r in raw
                ]
            else:
                # ddgs.text returns dicts with: title, href, body
                raw = list(ddgs.text(query, max_results=num)) or []
                return [
                    {
                        "title": r.get("title", ""),
                        "url": r.get("href", ""),
                        "publisher": urlparse(r.get("href", "")).hostname or "",
                        "date": None,
                        "byline": None,
                        "body": r.get("body", ""),
                    }
                    for r in raw
                ]
    except Exception as e:
        log.warning("ddgs search failed (%s): %s", query, e)
        return []


def _search_result_to_source(
    r: dict, *, source_type: str, prefix: str,
) -> Optional[Source]:
    """Convert a DDG search result into a Source with the snippet pre-loaded
    as `text`. fetch.py will try to enrich it; if fetch fails, the snippet
    survives and the verifier still has something to substring-match against.
    """
    url = r.get("url") or ""
    if not url:
        return None
    snippet = (r.get("title", "") + "\n\n" + (r.get("body") or "")).strip()
    return Source(
        id=_stable_id(prefix, url),
        type=source_type,                       # type: ignore[arg-type]
        url=url,
        publisher=r.get("publisher") or urlparse(url).hostname or "",
        title=r.get("title", "") or url,
        accessed_at=datetime.now(timezone.utc),
        text=snippet if len(snippet) > 80 else None,
    )


def discover_news(company: str, *, limit: int = 8) -> List[Source]:
    queries = [
        # Standard breadth queries
        f'"{company}" earnings OR layoffs OR restructuring',
        f'"{company}" CEO OR CFO interview',
        f'"{company}" announces OR launches',
        # Adversarial / pessimistic queries — surfaces real risk signal
        # when it exists. The relevance gate still drops sources that
        # don't actually mention the prospect, so these aren't a noise
        # source; they're a recall improvement on the risk-detection
        # path. Hits primarily land in litigation_or_regulatory or
        # financial_signals fact kinds, which feed the Red Flags section
        # and the strategist's Weak Risk Signals archetypes.
        f'"{company}" lawsuit OR dispute OR "safety violation"',
        f'"{company}" OSHA OR fine OR penalty',
    ]
    seen = set()
    out: List[Source] = []
    for q in queries:
        for r in web_search(q, num=limit, news_only=True):
            url = r["url"]
            if url in seen or not url:
                continue
            seen.add(url)
            try:
                pub_date = _parse_loose_date(r.get("date"))
            except Exception:
                pub_date = None
            out.append(Source(
                id=f"NEWS:{len(seen):03d}",
                type="news_article",
                url=url,
                publisher=r["publisher"] or urlparse(url).hostname or "",
                publish_date=pub_date,
                title=r["title"],
                accessed_at=datetime.now(timezone.utc),
                byline=r.get("byline"),
            ))
    return out[:limit * 2]


def _parse_loose_date(s: Optional[str]) -> Optional[date]:
    if not s:
        return None
    # ISO 8601 from ddgs.news (e.g. "2026-05-07T14:22:00+00:00")
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).date()
    except (ValueError, AttributeError):
        pass
    # Relative: "2 days ago", "3 weeks ago"
    m = re.match(r"(\d+)\s+(day|week|month|year)s?\s+ago", s, re.I)
    if m:
        n, unit = int(m.group(1)), m.group(2).lower()
        days = {"day": 1, "week": 7, "month": 30, "year": 365}[unit] * n
        return (datetime.now(timezone.utc) - timedelta(days=days)).date()
    for fmt in ("%b %d, %Y", "%B %d, %Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


# ---------------------------------------------------------------------------
# Industry adapters — DDG site: queries against vertical databases.
# ---------------------------------------------------------------------------

# To extend: add another industry → list of (label, query_template) entries.
# {company} is interpolated.
INDUSTRY_QUERIES = {
    "construction": [
        # Permits / contractor profiles
        ('site:buildzoom.com "{company}"', 3),
        ('site:dodge.construction.com "{company}"', 2),
        ('site:enr.com "{company}"', 2),
        # State procurement portals (extend per-state as needed)
        ('site:procurement.sc.gov "{company}"', 2),
        ('site:scbid.scdc.sc.gov "{company}"', 2),
        ('site:bidnetdirect.com "{company}"', 2),
        # OSHA enforcement records (red-flag-eligible if found)
        ('site:osha.gov "{company}"', 2),
    ],
    "healthcare": [
        ('site:fda.gov "{company}"', 3),
        ('site:cms.gov "{company}"', 3),
        ('site:openpaymentsdata.cms.gov "{company}"', 2),
    ],
    "finance": [
        ('site:finra.org "{company}"', 3),
        ('site:occ.gov "{company}"', 2),
    ],
    # Generic fallback
    "general": [
        ('site:linkedin.com/company "{company}"', 2),
    ],
}


def discover_industry_signals(
    company: str, *, kinds: Iterable[str] = ("construction",),
) -> List[Source]:
    """Run vertical-database queries via DDG. Snippets are kept as source.text
    so we don't depend on whether the database site allows direct fetching."""
    out: List[Source] = []
    seen_urls: set[str] = set()
    for kind in kinds:
        for tmpl, n in INDUSTRY_QUERIES.get(kind, []):
            q = tmpl.format(company=company)
            for r in web_search(q, num=n, news_only=False):
                url = r.get("url", "")
                if not url or url in seen_urls:
                    continue
                seen_urls.add(url)
                src = _search_result_to_source(
                    r, source_type="industry_database", prefix="IND",
                )
                if src:
                    out.append(src)
    return out


# ---------------------------------------------------------------------------
# LinkedIn leadership discovery via DDG snippets.
# ---------------------------------------------------------------------------

def discover_leadership_linkedin(company: str) -> List[Source]:
    """Find leadership profiles by querying DDG for LinkedIn pages mentioning
    the company. We use ONLY the DDG-returned snippet — no LinkedIn scraping —
    since LinkedIn requires login. The snippet typically carries the title +
    company line, which is enough for the extractor to identify role/person."""
    queries = [
        f'site:linkedin.com/in/ "{company}"',
        f'site:linkedin.com "{company}" CEO OR president OR founder',
        f'site:linkedin.com "{company}" principal OR partner OR director',
    ]
    out: List[Source] = []
    seen_urls: set[str] = set()
    for q in queries:
        for r in web_search(q, num=4, news_only=False):
            url = r.get("url", "")
            if not url or url in seen_urls:
                continue
            seen_urls.add(url)
            src = _search_result_to_source(
                r, source_type="linkedin_profile", prefix="LI",
            )
            if src:
                out.append(src)
    return out


# ---------------------------------------------------------------------------
# User-supplied seed URLs.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Federal public-records adapters — high-signal for B2G prospects.
# ---------------------------------------------------------------------------

def discover_usaspending(company: str, *,
                        aliases: Iterable[str] = (),
                        max_recipients: int = 2,
                        max_awards: int = 8) -> List[Source]:
    """Build synthetic Source objects from USAspending.gov federal contract
    data. Public REST API, no key required.

    Searches the autocomplete endpoint for the company name AND any aliases
    (legal entity names, common variants). Brantley's contracts are filed
    under "Brantley Construction Services LLC" (legal) but the prospect is
    typically referred to by the trade name "Brantley Construction Company"
    — without searching both, we miss the federal record.

    For each matched recipient: pull a short list of top contracts and bake
    them into source.text as structured prose. The extractor pulls
    customer_or_partnership / financial_signals facts from that text.
    """
    out: List[Source] = []
    seen_recipients: set = set()
    search_terms = [company] + [a for a in aliases if a]

    candidates: list[dict] = []
    for term in search_terms:
        try:
            with _http() as c:
                r = c.post(
                    "https://api.usaspending.gov/api/v2/autocomplete/recipient/",
                    json={"search_text": term, "limit": 5},
                    timeout=config.HTTP_TIMEOUT_SECONDS,
                )
                r.raise_for_status()
                results = r.json().get("results", []) or []
        except Exception as e:
            log.warning("usaspending autocomplete failed for %r: %s", term, e)
            continue
        for cand in results:
            name = (cand.get("recipient_name") or "").strip().lower()
            if name and name not in seen_recipients:
                seen_recipients.add(name)
                candidates.append(cand)

    if not candidates:
        return []

    for cand in candidates[:max_recipients]:
        # `recipient_id_list` is a list of recipient_ids — first one is the canonical.
        rid_list = cand.get("recipient_id_list") or []
        recipient_id = rid_list[0] if rid_list else None
        recipient_name = cand.get("recipient_name") or company
        uei = cand.get("uei")
        duns = cand.get("duns")

        # Pull top contracts for this recipient.
        awards: list[dict] = []
        try:
            with _http() as c:
                r = c.post(
                    "https://api.usaspending.gov/api/v2/search/spending_by_award/",
                    json={
                        "filters": {
                            "recipient_search_text": [recipient_name],
                            "award_type_codes": ["A", "B", "C", "D"],   # contract types
                            "time_period": [{"start_date": "2020-01-01",
                                             "end_date": "2026-12-31"}],
                        },
                        "fields": ["Award ID", "Recipient Name",
                                   "Awarding Agency", "Award Amount",
                                   "Action Date", "Description",
                                   "Place of Performance State Code"],
                        "page": 1, "limit": max_awards,
                        "sort": "Award Amount", "order": "desc",
                    },
                    timeout=config.HTTP_TIMEOUT_SECONDS,
                )
                r.raise_for_status()
                awards = r.json().get("results", []) or []
        except Exception as e:
            log.warning("usaspending awards fetch failed for %s: %s",
                        recipient_name, e)

        # Build a structured-prose summary the extractor can read.
        lines = [f"USAspending.gov federal contract record: {recipient_name}"]
        if uei:
            lines.append(f"UEI: {uei}")
        if duns:
            lines.append(f"DUNS: {duns}")
        if awards:
            total = sum((a.get("Award Amount") or 0) for a in awards)
            lines.append(
                f"Top {len(awards)} federal contracts (since 2020) "
                f"total ${total:,.0f}."
            )
            for a in awards:
                amt = a.get("Award Amount") or 0
                agency = a.get("Awarding Agency") or "agency unspecified"
                desc = (a.get("Description") or "no description")[:100]
                act = a.get("Action Date") or ""
                state = a.get("Place of Performance State Code") or ""
                lines.append(
                    f"Contract: ${amt:,.0f} from {agency} on {act} "
                    f"in {state} for: {desc}"
                )
        else:
            lines.append("No contract awards found in coverage window.")

        url = (f"https://www.usaspending.gov/recipient/{recipient_id}/latest"
               if recipient_id
               else f"https://www.usaspending.gov/search/?keywords={company}")

        out.append(Source(
            id=_stable_id("USASPEND", recipient_name),
            type="regulatory_filing",                                 # type: ignore[arg-type]
            url=url,
            publisher="usaspending.gov",
            title=f"USAspending federal contracts: {recipient_name}",
            accessed_at=datetime.now(timezone.utc),
            text="\n".join(lines),
        ))
    return out


def discover_sam_gov(company: str) -> List[Source]:
    """SAM.gov entity record. Requires SAM_GOV_API_KEY (free tier exists at
    sam.gov; the key is per-user). Returns canonical legal name, NAICS codes,
    business-type flags (small/woman-owned/veteran-owned), and registration
    status. Skips quietly if no key is set.
    """
    api_key = os.environ.get("SAM_GOV_API_KEY")
    if not api_key:
        return []

    try:
        with _http() as c:
            r = c.get(
                "https://api.sam.gov/entity-information/v3/entities",
                params={"api_key": api_key, "samRegistered": "Yes",
                        "qterms": company, "page": 0, "size": 5},
                timeout=config.HTTP_TIMEOUT_SECONDS,
            )
            r.raise_for_status()
            data = r.json()
    except Exception as e:
        log.warning("sam.gov entity search failed: %s", e)
        return []

    out: List[Source] = []
    entities = (data.get("entityData") or [])[:3]
    for ent in entities:
        core = ent.get("entityRegistration") or {}
        legal_name = core.get("legalBusinessName") or company
        uei = core.get("ueiSAM") or ""
        cage = core.get("cageCode") or ""
        status = core.get("registrationStatus") or ""

        addrs = ent.get("coreData", {}).get("physicalAddress") or {}
        city = addrs.get("city") or ""
        state = addrs.get("stateOrProvinceCode") or ""

        # NAICS
        naics_list = ent.get("assertions", {}).get("goodsAndServices", {}).get(
            "naicsList") or []
        naics_codes = [n.get("naicsCode") for n in naics_list if n.get("naicsCode")]

        # Business types
        biz_types_raw = ent.get("assertions", {}).get("businessTypes", {}).get(
            "businessTypeList") or []
        biz_types = [b.get("businessTypeDesc") for b in biz_types_raw
                     if b.get("businessTypeDesc")]

        lines = [f"SAM.gov entity record: {legal_name}"]
        if uei: lines.append(f"UEI: {uei}")
        if cage: lines.append(f"CAGE code: {cage}")
        if status: lines.append(f"Registration status: {status}")
        if city or state: lines.append(f"Physical address: {city}, {state}")
        if naics_codes: lines.append(f"NAICS codes: {', '.join(naics_codes[:5])}")
        if biz_types:
            lines.append(f"Business types: {'; '.join(biz_types[:6])}")

        out.append(Source(
            id=f"SAM:{uei}" if uei else _stable_id("SAM", legal_name),
            type="regulatory_filing",                                 # type: ignore[arg-type]
            url=f"https://sam.gov/entity/{uei}/coreData" if uei
                else f"https://sam.gov/search/?index=ei&q={company}",
            publisher="sam.gov",
            title=f"SAM.gov entity: {legal_name}",
            accessed_at=datetime.now(timezone.utc),
            text="\n".join(lines),
        ))
    return out


def seed_urls_to_sources(urls: List[str]) -> List[Source]:
    """Convert a list of URLs into Source candidates. fetch.py will hydrate."""
    out: List[Source] = []
    for url in urls:
        if not url or not url.strip():
            continue
        url = url.strip()
        host = (urlparse(url).hostname or "").lower().lstrip("www.")
        # Heuristic source-type assignment — affects red-flag eligibility and
        # recency window. The user can edit the type in the audit JSON if it
        # matters for their workflow.
        if "linkedin.com" in host:
            stype: str = "linkedin_profile"
        elif any(d in host for d in ("buildzoom.com", "dodge.construction.com",
                                     "enr.com", "bidnetdirect.com")):
            stype = "industry_database"
        elif "procurement" in host or host.endswith(".gov"):
            stype = "regulatory_filing"
        elif "sec.gov" in host:
            stype = "8-K"   # safe default; will be refined if URL matches pattern
        elif "press" in url.lower() or "news-release" in url.lower():
            stype = "press_release"
        else:
            stype = "user_seeded"
        out.append(Source(
            id=_stable_id("SEED", url),
            type=stype,                                  # type: ignore[arg-type]
            url=url,
            publisher=host,
            title=f"User-seeded: {url}",
            accessed_at=datetime.now(timezone.utc),
        ))
    return out


# ---------------------------------------------------------------------------
# Top-level discovery — call this from the pipeline
# ---------------------------------------------------------------------------

def discover_all(
    company: str,
    ticker: Optional[str],
    domain: Optional[str],
    *,
    industry_kinds: Iterable[str] = (),
    include_linkedin: bool = False,
    include_federal: bool = False,
    seed_urls: Optional[List[str]] = None,
    aliases: Iterable[str] = (),
) -> List[Source]:
    sources: List[Source] = []
    if ticker:
        try:
            sources.extend(edgar_recent_filings(ticker))
        except Exception as e:
            log.warning("EDGAR error: %s", e)
    if domain:
        try:
            sources.extend(discover_company_pages(domain))
        except Exception as e:
            log.warning("domain probe error: %s", e)
    try:
        sources.extend(discover_news(company))
    except Exception as e:
        log.warning("news search error: %s", e)
    if industry_kinds:
        try:
            sources.extend(discover_industry_signals(company, kinds=industry_kinds))
        except Exception as e:
            log.warning("industry adapter error: %s", e)
    if include_linkedin:
        try:
            sources.extend(discover_leadership_linkedin(company))
        except Exception as e:
            log.warning("linkedin discovery error: %s", e)
    if include_federal:
        try:
            sources.extend(discover_usaspending(company, aliases=aliases))
        except Exception as e:
            log.warning("usaspending error: %s", e)
        try:
            sources.extend(discover_sam_gov(company))   # no-op without API key
        except Exception as e:
            log.warning("sam.gov error: %s", e)
    if seed_urls:
        sources.extend(seed_urls_to_sources(seed_urls))
    return sources
