"""Fetch source URLs and extract clean text for downstream stages.

Uses httpx for transport and trafilatura for content extraction (handles
boilerplate stripping for news pages and press releases). PDFs are routed
through pdfplumber. A two-namespace disk cache (see cache.py) makes
re-runs fast and cheap.
"""

from __future__ import annotations
import io
import logging
from typing import List

import httpx
import trafilatura
from bs4 import BeautifulSoup

from .schema import Source
from . import config
from . import cache as _cache

log = logging.getLogger(__name__)


def _extract_pdf(content: bytes) -> str:
    """Pull text out of a PDF. pdfplumber is import-on-demand so the
    common-case (HTML) doesn't pay its load cost."""
    try:
        import pdfplumber
    except ImportError:
        log.warning("pdfplumber not installed; PDF will be skipped. "
                    "Install with: pip install pdfplumber")
        return ""
    try:
        pages = []
        with pdfplumber.open(io.BytesIO(content)) as pdf:
            for page in pdf.pages:
                t = page.extract_text() or ""
                if t.strip():
                    pages.append(t)
        return "\n\n".join(pages)
    except Exception as e:
        log.warning("pdfplumber failed: %s", e)
        return ""


def _extract_html(html: str) -> str:
    # Always parse the full DOM so we can pull footer text separately —
    # company addresses, contact info, and CAGE/UEI codes very often live
    # in footers / contact blocks that trafilatura's "article body" mode
    # strips away.
    soup = BeautifulSoup(html, "html.parser")
    footer_text = ""
    for tag in soup.find_all(["footer", "address"]):
        t = tag.get_text(separator=" ", strip=True)
        if t and t not in footer_text:
            footer_text += "\n" + t

    # Try trafilatura first — best for news, blog posts, press releases.
    extracted = trafilatura.extract(
        html,
        include_comments=False,
        include_tables=True,
        favor_recall=True,
    )
    if extracted and len(extracted) > 400:
        # Append footer text if it's not already in the extracted body
        # (trafilatura usually drops it).
        if footer_text and footer_text.strip() not in extracted:
            extracted = extracted + "\n\n" + footer_text.strip()
        return extracted

    # BS4 fallback — strip noise EXCEPT footer and address tags.
    soup_copy = BeautifulSoup(html, "html.parser")
    for tag in soup_copy(["script", "style", "nav", "aside"]):
        tag.decompose()
    body_text = "\n".join(
        p.get_text(strip=True)
        for p in soup_copy.find_all(["p", "h1", "h2", "h3", "li", "td"])
        if p.get_text(strip=True)
    )
    if footer_text:
        body_text = body_text + "\n\n" + footer_text.strip()
    return body_text


def fetch_text(url: str, *, use_cache: bool = True) -> str:
    """Pull a URL and return cleaned text. Empty string on failure.

    Cache: keyed on URL, default TTL 7 days. Set CACHE_DISABLED=1 to bypass
    cache reads (writes still happen so the next call is fast)."""
    if use_cache and not _cache.reads_disabled():
        hit = _cache.cache_get("fetch", _cache.fetch_cache_key(url))
        if hit is not None:
            return hit

    try:
        with httpx.Client(
            timeout=config.HTTP_TIMEOUT_SECONDS,
            headers={"User-Agent": config.USER_AGENT},
            follow_redirects=True,
        ) as c:
            r = c.get(url)
            r.raise_for_status()
            content_type = (r.headers.get("content-type") or "").lower()
            content = r.content
    except Exception as e:
        log.warning("fetch failed %s: %s", url, e)
        return ""

    # PDF route — content-type sniff plus magic-byte fallback.
    if "application/pdf" in content_type or content[:5] == b"%PDF-":
        text = _extract_pdf(content)
    else:
        try:
            html = content.decode(r.encoding or "utf-8", errors="replace")
        except (LookupError, UnicodeDecodeError):
            html = content.decode("utf-8", errors="replace")
        text = _extract_html(html)

    if use_cache and text:
        _cache.cache_put("fetch", _cache.fetch_cache_key(url), text)

    return text


def hydrate_sources(sources: List[Source]) -> List[Source]:
    """Populate `text` on every source.

    Sources may arrive with pre-populated `text` (e.g. DDG search snippets for
    LinkedIn profiles or industry databases that block direct fetching). In
    that case we still try to fetch — a successful full-page fetch is richer
    — but if fetch fails or returns less content than the snippet, we keep
    the snippet. This protects the LinkedIn / BuildZoom path from being
    silently dropped just because the page requires login.
    """
    out: List[Source] = []
    for s in sources:
        prepop = s.text or ""
        # Skip fetching if we already have substantial pre-populated text and
        # the URL is on a known login-walled domain.
        skip_fetch = (
            len(prepop) > 200 and any(
                d in (s.url or "") for d in ("linkedin.com",)
            )
        )
        fetched = "" if skip_fetch else fetch_text(s.url)
        # Keep whichever is longer / more useful.
        if len(fetched) > len(prepop):
            s.text = fetched
        else:
            s.text = prepop or fetched

        if s.text and len(s.text) > 100:
            out.append(s)
        else:
            log.info("dropping source %s: no usable text", s.url)
    return out
