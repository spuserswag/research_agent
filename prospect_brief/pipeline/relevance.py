"""Source relevance gate.

Catches the "common surname" failure mode: when a search for a company like
"Brantley Construction Company" returns articles about people named Brantley
(or any unrelated entity that happens to share a token with the company name),
the extractor will dutifully pull facts from those articles and attribute them
to the prospect — producing confidently-wrong briefs.

This module enforces a simple, defensible rule: a source is "about" the
prospect only if it contains the company's distinctive multi-word phrase OR
its domain. Common corporate suffixes ("Inc", "LLC", "Company", "Corp") are
stripped before matching so "Brantley Construction Company" still matches a
source that says "Brantley Construction".

If you have a single-word company name (e.g. "Acme") and no domain, the gate
is permissive — there's nothing distinctive to match on. In that case the
caller should pass `extra_required_phrases` (e.g. industry / location words)
to disambiguate.
"""

from __future__ import annotations
import logging
import re
from typing import Iterable, List, Optional, Tuple

from .schema import Source

log = logging.getLogger(__name__)

# Words we strip from the company name before phrase-matching.
_CORPORATE_SUFFIX_RE = re.compile(
    r"\b(company|companies|inc|incorporated|llc|llp|"
    r"corporation|corp|ltd|limited|holdings|group|"
    r"co|plc|p\.?l\.?c\.?|s\.?a\.?|s\.?p\.?a\.?|gmbh|ag|nv|bv)\b\.?",
    flags=re.IGNORECASE,
)
_WS_RE = re.compile(r"\s+")


def _normalize_phrase(s: str) -> str:
    s = _CORPORATE_SUFFIX_RE.sub("", s)
    s = _WS_RE.sub(" ", s).strip().lower()
    # Drop trailing punctuation
    return s.rstrip(",.!?-:;")


def _normalize_text(s: str) -> str:
    return _WS_RE.sub(" ", s).lower()


def is_source_about(
    source: Source,
    company: str,
    *,
    domain: Optional[str] = None,
    disambiguators: Iterable[str] = (),
    trusted_urls: Iterable[str] = (),
) -> Tuple[bool, str]:
    """Return (is_relevant, reason). reason is empty if relevant.

    Decision tree:
      1. Source has no usable text → drop.
      2. URL exactly matches a trusted_url (user-seeded) → keep.
      3. linkedin_profile source: keep if company phrase is in text.
      4. Domain provided AND appears in URL or text → keep (canonical).
      5. Company phrase appears in text:
         - If `disambiguators` are provided, at least one MUST appear too.
         - If no disambiguators provided, accept on phrase alone (legacy).
      6. Otherwise → drop.

    NOTE on trust: we previously trusted entire hostnames (`buildzoom.com`)
    when the user seeded a single URL on that host. That's too broad —
    BuildZoom hosts both your prospect AND same-name impostors. The trust
    list now requires exact URL match.
    """
    if not source.text:
        return False, "no source text"

    text = _normalize_text(source.text)
    url = (source.url or "").lower()
    name_core = _normalize_phrase(company)

    # Trusted-URL bypass — only the EXACT URLs the user explicitly seeded.
    trusted_set = {u.lower().rstrip("/") for u in trusted_urls}
    if url.rstrip("/") in trusted_set:
        return True, ""

    # LinkedIn /in/ profiles are exempt from the disambiguator gate.
    # LinkedIn explicitly attributes a person to a named company, which is a
    # more structured identity claim than a random web page mentioning the
    # name. The geography that disambiguators check for is rarely in the
    # search snippet, so requiring it here drops legitimate leadership
    # profiles. We still require the company phrase to be present.
    if source.type == "linkedin_profile":
        if " " in name_core and name_core in text:
            return True, ""
        return False, "linkedin profile without company phrase in snippet"

    # Domain match is unambiguous and wins outright.
    if domain:
        d = domain.lower().lstrip("www.")
        if d in url or d in text:
            return True, ""

    disambig_list = [p.lower() for p in disambiguators]

    # Phrase match — but with disambiguator gate when impostors are a risk.
    phrase_present = (
        (" " in name_core and name_core in text)
        or (name_core in text and len(name_core) > 6)
    )
    if phrase_present:
        if disambig_list:
            if not any(d in text or d in url for d in disambig_list):
                return False, (
                    f"phrase match without any disambiguator "
                    f"({disambig_list[:2]}…) — likely same-name impostor"
                )
        return True, ""

    # Single-token name with no domain: permissive only if disambiguators match.
    if " " not in name_core:
        if disambig_list and all(
            p in text or p in url for p in disambig_list
        ):
            return True, ""
        return False, (
            f"single-token name {name_core!r} is too ambiguous; pass a domain "
            f"or disambiguators (e.g. HQ city, state)"
        )

    return False, f"company phrase {name_core!r} not present in source text"


def filter_for_relevance(
    sources: List[Source],
    company: str,
    *,
    domain: Optional[str] = None,
    disambiguators: Iterable[str] = (),
    trusted_urls: Iterable[str] = (),
) -> Tuple[List[Source], List[str]]:
    """Split sources into (kept, gap_messages_for_dropped).

    The dropped sources are described in the returned gap messages so the
    final brief's "What we couldn't find" section can surface them.
    """
    kept: List[Source] = []
    gap_msgs: List[str] = []
    for s in sources:
        ok, reason = is_source_about(
            s, company, domain=domain,
            disambiguators=disambiguators,
            trusted_urls=trusted_urls,
        )
        if ok:
            kept.append(s)
        else:
            log.info("relevance: dropped %s — %s", s.url, reason)
            gap_msgs.append(
                f"Search returned source not about {company!r}: "
                f"{s.publisher} ({s.url}) — {reason}"
            )
    return kept, gap_msgs
