"""Entry point.

    python cli.py --company "Asana" --ticker ASAN \
        --domain asana.com \
        --ae "J. Chen" --meeting-date 2026-05-09 \
        --out examples/ASAN/
"""

from __future__ import annotations
import logging
import os
import sys
from datetime import date
from pathlib import Path

# Load .env before reading API keys.
try:
    from dotenv import load_dotenv, find_dotenv
    load_dotenv(find_dotenv(usecwd=True), override=False)
except ImportError:
    print("note: python-dotenv not installed — .env file will not be auto-loaded.",
          file=sys.stderr)

import typer

from pipeline.pipeline import run as run_pipeline
from pipeline import cache as _cache

app = typer.Typer(add_completion=False)


@app.command()
def main(
    company: str = typer.Option(..., help="Company display name (e.g. 'Asana')."),
    ticker: str = typer.Option(None, help="Stock ticker if public (e.g. 'ASAN')."),
    domain: str = typer.Option(None, help="Company domain (e.g. 'asana.com')."),
    ae: str = typer.Option("Account Executive", help="AE name for the brief header."),
    meeting_date: str = typer.Option(
        ..., "--meeting-date", help="ISO date of the meeting, e.g. 2026-05-09."
    ),
    out: Path = typer.Option(..., help="Output directory."),
    coverage_days: int = typer.Option(270, help="How far back to look (default 270)."),
    industry: list[str] = typer.Option(
        [], "--industry",
        help="Industry adapter to enable. Repeat to add multiple. "
             "Choices: construction, healthcare, finance, general.",
    ),
    linkedin: bool = typer.Option(
        False, "--linkedin/--no-linkedin",
        help="Run DDG-based LinkedIn leadership discovery (snippets only).",
    ),
    federal: bool = typer.Option(
        False, "--federal/--no-federal",
        help="Pull USAspending.gov federal contract record + SAM.gov entity "
             "data (SAM.gov requires SAM_GOV_API_KEY; USAspending is keyless).",
    ),
    disambiguator: list[str] = typer.Option(
        [], "--disambiguator",
        help="Identifying tokens to filter out same-name impostors "
             "(e.g. 'Charleston', 'SC'). Required if multiple companies share "
             "the trade name. Repeat for multiple.",
    ),
    alias: list[str] = typer.Option(
        [], "--alias",
        help="Additional name to search under (e.g. legal entity name "
             "'Brantley Construction Services LLC'). Federal records often "
             "use legal name not trade name. Repeat for multiple.",
    ),
    strategist: bool = typer.Option(
        False, "--strategist/--no-strategist",
        help="Run the inference layer (revenue triangulation, market "
             "position, tailored value hooks). Output is clearly labeled "
             "[inferred] and never confused with verified facts.",
    ),
    audience: str = typer.Option(
        "generic", "--audience",
        help="Meeting persona: ceo, cto, cfo, coo, cro, or generic. "
             "Tailors discovery questions and strategist value hooks. "
             "Default: generic (CEO-flavored).",
    ),
    seed_url: list[str] = typer.Option(
        [], "--seed-url",
        help="A URL you want extracted (a project page, a local news piece). "
             "Repeat for multiple.",
    ),
    seed_urls_file: Path = typer.Option(
        None, "--seed-urls-file",
        help="Path to a text file with one URL per line. Combined with --seed-url.",
    ),
    no_cache: bool = typer.Option(
        False, "--no-cache",
        help="Bypass cache reads for this run (writes still happen).",
    ),
    clear_cache: bool = typer.Option(
        False, "--clear-cache",
        help="Wipe the disk cache before running.",
    ),
    verbose: bool = typer.Option(False, "--verbose", "-v"),
):
    logging.basicConfig(
        level=logging.INFO if verbose else logging.WARNING,
        format="%(asctime)s %(levelname)-7s %(message)s",
    )

    if clear_cache:
        n = _cache.clear_all()
        typer.echo(f"Cleared {n} cached entries.")
    if no_cache:
        os.environ["CACHE_DISABLED"] = "1"

    seed_urls: list[str] = list(seed_url)
    if seed_urls_file and seed_urls_file.exists():
        seed_urls.extend(
            line.strip() for line in seed_urls_file.read_text().splitlines()
            if line.strip() and not line.strip().startswith("#")
        )

    run_pipeline(
        company=company,
        ticker=ticker,
        domain=domain,
        ae=ae,
        meeting_date=date.fromisoformat(meeting_date),
        out_dir=out,
        coverage_days=coverage_days,
        industry_kinds=tuple(industry),
        include_linkedin=linkedin,
        include_federal=federal,
        seed_urls=seed_urls or None,
        disambiguators=tuple(disambiguator),
        aliases=tuple(alias),
        strategist=strategist,
        audience=audience,
    )
    typer.echo(f"Brief written to {out / 'brief.md'}")


if __name__ == "__main__":
    app()
