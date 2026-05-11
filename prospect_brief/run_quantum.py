"""Drop-in run script for Quantum Reality Capture (Charleston, SC).

LiDAR / reality-capture services for AEC firms. Same overall shape as
Brantley — private, regional, B2G — so the same adapter mix applies.

Usage:
    cd /Users/spenser/Desktop/Crawler2/prospect_brief
    python3 run_quantum.py

To do this for a NEW prospect:
  1. Copy this file to run_<company>.py
  2. Edit the constants at the top (COMPANY, DOMAIN, AE, etc.)
  3. Add 3-5 high-signal seed URLs (their About / Team page, LinkedIn,
     any local-news pieces, federal records, etc.)
  4. python3 run_<company>.py
"""

from __future__ import annotations
import os
import sys
from datetime import date, timedelta
from pathlib import Path

# ---------------------------------------------------------------------------
# Load .env (walks up parent dirs to find one).
# ---------------------------------------------------------------------------

try:
    from dotenv import load_dotenv, find_dotenv
    load_dotenv(find_dotenv(usecwd=True), override=False)
except ImportError:
    print("note: python-dotenv not installed — .env will not be auto-loaded.",
          file=sys.stderr)

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("EXTRACTOR_MODEL_OVERRIDE", "gpt-4o-mini")

from pipeline import config  # noqa: E402
if os.environ.get("EXTRACTOR_MODEL_OVERRIDE"):
    config.EXTRACTOR_MODEL = os.environ["EXTRACTOR_MODEL_OVERRIDE"]

from pipeline.pipeline import run as run_pipeline  # noqa: E402

# ---------------------------------------------------------------------------
# Prospect — edit these for any new company.
# ---------------------------------------------------------------------------

COMPANY = "Quantum Reality Capture"
TICKER = None                                # private
DOMAIN = "quantumrealitycapture.com"
AE = "Account Executive"                     # ← change before sending
MEETING_DATE = date.today() + timedelta(days=2)
OUT_DIR = ROOT / "examples" / "QUANTUM"

# How far back to look. 18 months is a good default for private prospects.
COVERAGE_DAYS = 540

# Industry adapters. "construction" pulls BuildZoom, ENR, Dodge, OSHA, and
# state procurement portals — all relevant for an AEC services firm.
INDUSTRY_KINDS = ("construction",)

# LinkedIn leadership discovery (DDG snippet only — no scraping).
INCLUDE_LINKEDIN = True

# QRC has a federal-targeted variant (qrcgov.com), so they likely do B2G work.
INCLUDE_FEDERAL = True

# Geography disambiguators — protect against same-name impostors. "Quantum"
# is a common prefix for unrelated tech companies (Quantum Capture is a
# Toronto AR/VR company, very different). Forcing Charleston/SC keeps the
# right entity.
DISAMBIGUATORS = ("charleston", "south carolina", "sc")

# Alternate / legal entity names to also search (USAspending, etc.).
ALIASES = (
    "Quantum Reality Capture LLC",
    "Quantum Reality Capture, LLC",
    "QRC",
)

# Run the strategist layer (revenue triangulation, market position, hooks).
RUN_STRATEGIST = True

# Meeting persona — tailors discovery questions and strategist value hooks.
# One of: ceo, cto, cfo, coo, cro, generic.
# QRC is a tech-forward AEC firm running cutting-edge SLAM / Gaussian
# Splatting workflows — for a CTO meeting, the CTO bank surfaces
# processing-tax / build-vs-buy / data-gravity questions instead of
# generic revenue-trajectory openers.
AUDIENCE = "cto"

# Known canonical URLs — their own pages plus aggregator profiles. Each one
# bypasses the relevance gate (trusted exact URL) and goes through extract.
SEED_URLS: list[str] = [
    "https://www.quantumrealitycapture.com/",
    "https://www.quantumrealitycapture.com/about/",
    "https://quantumrealitycapture.com/team/",
    "https://www.quantumrealitycapture.com/services/",
    "https://quantumrealitycapture.com/contact/",
    # Federal-targeted variant — capabilities statement for govt buyers
    "https://www.qrcgov.com/",
    # LinkedIn company page
    "https://www.linkedin.com/company/quantum-reality-capture",
    # ZoomInfo profile (may 403 — keep anyway, costs nothing if it fails)
    "https://www.zoominfo.com/pic/quantum-reality-capture/1322569383",
]


def preflight():
    if not os.environ.get("OPENAI_API_KEY"):
        print("ERROR: set OPENAI_API_KEY before running "
              "(via .env or `export OPENAI_API_KEY=...`).", file=sys.stderr)
        sys.exit(2)


def main():
    preflight()
    print(f"Running prospect_brief on: {COMPANY}")
    print(f"  domain         : {DOMAIN}")
    print(f"  AE             : {AE}")
    print(f"  meeting date   : {MEETING_DATE.isoformat()}")
    print(f"  coverage window: {COVERAGE_DAYS} days")
    print(f"  extractor model: {config.EXTRACTOR_MODEL}")
    print(f"  strategist on  : {RUN_STRATEGIST}")
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
          f"{vf.verifier_log.quotes_checked} quotes matched. "
          f"{len(vf.verifier_log.stripped)} stripped.")
    print()
    print(f"Brief written to: {OUT_DIR / 'brief.md'}")
    print(f"Audit trail:      {OUT_DIR / 'facts.json'}")
    print(f"Evidence packet:  {OUT_DIR / 'sources.md'}")


if __name__ == "__main__":
    main()
