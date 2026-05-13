"""End-to-end orchestration."""

from __future__ import annotations
import json
import logging
from datetime import date, datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

from .schema import VerifiedFacts
from . import sources as src_mod
from . import fetch as fetch_mod
from . import extract as extract_mod
from . import verify as verify_mod
from . import render as render_mod
from . import relevance as relevance_mod
from . import inference as inference_mod
from . import config

log = logging.getLogger(__name__)


def run(
    *,
    company: str,
    ticker: Optional[str],
    domain: Optional[str],
    ae: str,
    meeting_date: date,
    out_dir: Path,
    coverage_days: int = 270,
    industry_kinds: tuple[str, ...] = (),
    include_linkedin: bool = False,
    include_federal: bool = False,
    seed_urls: Optional[list[str]] = None,
    disambiguators: tuple[str, ...] = (),
    aliases: tuple[str, ...] = (),
    strategist: bool = False,
    audience: str = "generic",
) -> VerifiedFacts:
    out_dir.mkdir(parents=True, exist_ok=True)
    today = date.today()
    coverage_start = today - timedelta(days=coverage_days)

    log.info("[1/5] Discovering sources for %s", company)
    candidates = src_mod.discover_all(
        company, ticker, domain,
        industry_kinds=industry_kinds,
        include_linkedin=include_linkedin,
        include_federal=include_federal,
        seed_urls=seed_urls or [],
        aliases=aliases,
    )
    log.info("  → %d candidates", len(candidates))

    log.info("[2/5] Fetching source text")
    hydrated = fetch_mod.hydrate_sources(candidates)
    log.info("  → %d hydrated", len(hydrated))

    log.info("[2.5/5] Relevance gate")
    # Trust ONLY the exact URLs the user seeded. Hostname-scoped trust was
    # too broad — BuildZoom and LinkedIn host both canonical entities and
    # same-name impostors on the same domain.
    relevant, dropped_msgs = relevance_mod.filter_for_relevance(
        hydrated, company, domain=domain,
        disambiguators=disambiguators,
        trusted_urls=list(seed_urls or []),
    )
    log.info("  → %d kept, %d dropped as not-about-prospect",
             len(relevant), len(dropped_msgs))

    log.info("[3/5] Extracting structured facts")
    extractions = extract_mod.extract_all(relevant)
    log.info("  → %d extractions", sum(
        len(e.leadership_changes) + len(e.exec_statements)
        + len(e.financial_signals) + len(e.hiring_signals)
        + len(e.litigation_or_regulatory) + len(e.product_launches)
        + len(e.customer_or_partnership) + len(e.funding_events)
        for e in extractions
    ))

    gaps: list[str] = []
    if not any(s.type == "earnings_call_transcript" for s in relevant):
        gaps.append("No earnings call transcript discovered in coverage window.")
    if not any(s.type in {"news_article"} for s in relevant):
        gaps.append("No relevant news articles found about this prospect.")
    # Surface up to 3 search-noise drops so the AE knows what was filtered.
    for msg in dropped_msgs[:3]:
        gaps.append(msg)
    if len(dropped_msgs) > 3:
        gaps.append(
            f"…and {len(dropped_msgs) - 3} more sources dropped by relevance gate "
            f"(see logs for details)."
        )

    log.info("[4/5] Verifying quotes against source text")
    vf = verify_mod.verify(
        extractions, relevant,
        company=company, ticker=ticker, ae=ae,
        meeting_date=meeting_date,
        coverage_window_start=coverage_start,
        coverage_window_end=today,
        gaps=gaps,
    )

    strategist_md = ""
    if strategist:
        log.info("[4.5/5] Running strategist inference")
        try:
            id_map = render_mod._renumber_for_strategist(vf)
            strategist_md = inference_mod.run_strategist(
                vf, id_map=id_map, audience=audience,
            )
            log.info("  → strategist returned %d chars", len(strategist_md))
        except Exception as e:
            log.warning("strategist failed (non-fatal): %s", e)

    log.info("[5/5] Rendering brief")
    md = render_mod.render_template(
        vf, strategist_md=strategist_md, audience=audience,
    )

    (out_dir / "brief.md").write_text(md)
    (out_dir / "facts.json").write_text(vf.model_dump_json(indent=2, exclude={"sources": {"__all__": {"text"}}}))
    log.info("Wrote %s", out_dir)
    return vf
