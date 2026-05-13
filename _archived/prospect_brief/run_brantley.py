"""Drop-in run script for Brantley Construction Company (Charleston, SC).

Usage:
    cd /Users/spenser/Desktop/Crawler2/prospect_brief
    pip install -r requirements.txt          # one-time
    # OPENAI_API_KEY can come from .env or a real env var
    python run_brantley.py

Outputs:
    examples/BRANTLEY/brief.md      the rendered brief
    examples/BRANTLEY/facts.json    full audit trail
    examples/BRANTLEY/sources.md    evidence packet

Notes
-----
* Brantley is private (no SEC filings, no earnings calls). The pipeline
  will skip EDGAR cleanly and rely on the company website + DuckDuckGo
  news/web search.
* Web search uses DuckDuckGo (no API key required). If DDG rate-limits
  the host (it does occasionally throttle), the pipeline degrades to
  direct site fetches and logs a warning — better than fabricating
  signals.
* We use gpt-4o-mini for the extractor stage to keep cost low. Override
  EXTRACTOR_MODEL_OVERRIDE in the env or edit pipeline/config.py if you
  want gpt-4o or another model.
"""

from __future__ import annotations
import os
import sys
from datetime import date, timedelta
from pathlib import Path

# ---------------------------------------------------------------------------
# Load .env (walks up parent dirs to find one). Real env vars win over .env.
# ---------------------------------------------------------------------------

try:
    from dotenv import load_dotenv, find_dotenv
    # override=False → existing real env vars take precedence over .env
    load_dotenv(find_dotenv(usecwd=True), override=False)
except ImportError:
    print("note: python-dotenv not installed — .env file will not be auto-loaded.\n"
          "      pip install python-dotenv  (or `pip install -r requirements.txt`)",
          file=sys.stderr)

# ---------------------------------------------------------------------------
# Make the pipeline package importable when run from anywhere.
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

# Default to gpt-4o-mini for cheap+fast extraction. Override via env if you
# want to use a stronger model.
os.environ.setdefault("EXTRACTOR_MODEL_OVERRIDE", "gpt-4o-mini")

from pipeline import config  # noqa: E402
if os.environ.get("EXTRACTOR_MODEL_OVERRIDE"):
    config.EXTRACTOR_MODEL = os.environ["EXTRACTOR_MODEL_OVERRIDE"]

from pipeline.pipeline import run as run_pipeline  # noqa: E402

# ---------------------------------------------------------------------------
# Run config — edit these if your meeting details change.
# ---------------------------------------------------------------------------

COMPANY = "Brantley Construction Company"
TICKER = None                                # private company
DOMAIN = "brantleyconstruction.com"
AE = "Account Executive"                     # ← change before sending
MEETING_DATE = date.today() + timedelta(days=2)   # default: 2 days out
OUT_DIR = ROOT / "examples" / "BRANTLEY"

# How far back to look. For a private regional GC, recent news is sparse;
# 18 months gives you enough room to catch project announcements.
COVERAGE_DAYS = 540

# Industry adapters to enable. For a GC, "construction" runs DDG site:
# queries against BuildZoom, ENR, Dodge, and SC procurement portals.
INDUSTRY_KINDS = ("construction",)

# Pull leadership profiles from LinkedIn via DDG snippets (no scraping).
INCLUDE_LINKEDIN = True

# Pull federal records: USAspending.gov contract history (no key) + SAM.gov
# entity data (only if SAM_GOV_API_KEY is in your .env). Worth turning on
# for any company that does B2G work — Brantley does (US Army Corps of
# Engineers came through in past briefs).
INCLUDE_FEDERAL = True

# Tokens that uniquely identify the right Brantley Construction. There's a
# Connecticut LLC with a similar name (Home Improvement Contractor) that
# would otherwise pollute the brief — these tokens force any phrase-only
# match to also reference the right geography.
DISAMBIGUATORS = ("charleston", "south carolina", "sc")

# Alternate / legal entity names. Federal records (USAspending.gov) file
# Brantley's contracts under the legal entity name, not the trade name.
# Without this list, USAspending search misses their $9M+ federal contracts.
ALIASES = (
    "Brantley Construction Services LLC",
    "Brantley Construction Services",
    "BCC",
)

# Run the strategist inference layer? When True, a clearly-labeled
# "Strategic context (inferred)" section is added to the brief with revenue
# triangulation, market position, and tailored value hooks. The verified-
# facts core is unchanged and the inference is visually demarcated.
RUN_STRATEGIST = True

# Meeting persona — one of: ceo, cto, cfo, coo, cro, generic. Tailors
# discovery questions and strategist value hooks. For a regional GC, "ceo"
# or "coo" is usually the right fit (they don't have a CTO).
AUDIENCE = "ceo"

# URLs you already know about — recent project blog posts, local news,
# specific permit pages — that you want extracted into the brief.
# These run through the same extract+verify pipeline as discovered sources.
# Edit / extend before running.
SEED_URLS: list[str] = [
    # Brantley's own About page — best source for company_profile facts.
    "https://brantleyconstruction.com/about/",
    # Their newsroom (top of feed; the extractor will pull from whatever's
    # most recent and the recency gate drops anything stale).
    "https://brantleyconstruction.com/news",
    # LinkedIn company page — leadership names, employee count, recent posts.
    # The pipeline reads the DDG snippet (LinkedIn requires login for full pages).
    "https://www.linkedin.com/company/brantley-construction-company",
    # BuildZoom contractor profile — permit history, project locations.
    "https://www.buildzoom.com/contractor/brantley-construction-company",
    # OpenCorporates — registration / officer data (works for most US companies,
    # no key required). Replaces Crunchbase which 403s every fetch.
    "https://opencorporates.com/companies?q=brantley+construction&jurisdiction_code=us_sc",
    # Add more as you find them — recent project announcements, local news,
    # bid award pages, OSHA inspection records, etc.
]


# ---------------------------------------------------------------------------
# Pre-flight checks — fail clearly rather than running into an opaque error.
# ---------------------------------------------------------------------------

def preflight():
    if not os.environ.get("OPENAI_API_KEY"):
        print("ERROR: set OPENAI_API_KEY before running "
              "(via .env or `export OPENAI_API_KEY=...`).", file=sys.stderr)
        sys.exit(2)


def search_supplement_queries():
    """Construction-industry queries that surface useful signals for a
    regional GC. The pipeline already runs DDG news/web searches against
    the company name, but these targeted queries are useful to run by hand
    if you want to seed extra URLs (paste them into a list the pipeline
    can pick up via a future --seed-urls flag)."""
    return [
        f'"{COMPANY}" project OR groundbreaking OR contract',
        f'"{COMPANY}" Charleston OR "North Charleston" awarded',
        f'"{COMPANY}" hiring OR jobs OR superintendent',
        f'"{COMPANY}" CEO OR president OR principal',
        f'"{COMPANY}" lawsuit OR OSHA OR violation',
        # Construction-specific public records
        f'site:buildzoom.com "Brantley Construction"',
        f'site:scbid.scdc.sc.gov OR site:procurement.sc.gov "Brantley"',
    ]


def main():
    preflight()
    print(f"Running prospect_brief on: {COMPANY}")
    print(f"  domain         : {DOMAIN}")
    print(f"  AE             : {AE}")
    print(f"  meeting date   : {MEETING_DATE.isoformat()}")
    print(f"  coverage window: {COVERAGE_DAYS} days")
    print(f"  extractor model: {config.EXTRACTOR_MODEL}")
    print(f"  out dir        : {OUT_DIR}")
    print()

    vf = run_pipeline(
        company=COMPANY,
        ticker=TICKER,
        domain=DOMAIN,
        ae=AE,
        meeting_date=MEETING_DATE,
        out_dir=OUT_DIR,
        coverage_days=COVERAGE_DAYS,
        industry_kinds=INDUSTRY_KINDS,
        include_linkedin=INCLUDE_LINKEDIN,
        include_federal=INCLUDE_FEDERAL,
        seed_urls=SEED_URLS or None,
        disambiguators=DISAMBIGUATORS,
        aliases=ALIASES,
        strategist=RUN_STRATEGIST,
        audience=AUDIENCE,
    )

    print()
    print(f"Verifier: {vf.verifier_log.quotes_passed}/"
          f"{vf.verifier_log.quotes_checked} quotes matched source text. "
          f"{len(vf.verifier_log.stripped)} stripped pre-publish.")
    print()
    print(f"Brief written to: {OUT_DIR / 'brief.md'}")
    print(f"Audit trail:      {OUT_DIR / 'facts.json'}")
    print(f"Evidence packet:  {OUT_DIR / 'sources.md'}")
    print()
    print("Suggested follow-up queries to run by hand if coverage is thin:")
    for q in search_supplement_queries():
        print(f"  - {q}")


if __name__ == "__main__":
    main()
