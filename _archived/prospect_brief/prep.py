"""Universal prospect-brief runner.

Reads a JSON lead file (one per prospect) and runs the pipeline. This is
the recommended entry point — no more per-prospect wrapper scripts.

Usage
-----

Single lead:

    python3 prep.py --lead leads/quantum.json

Multiple leads in one go:

    python3 prep.py --lead leads/quantum.json --lead leads/brantley.json

Ad-hoc overrides for a single run (without editing the lead file):

    python3 prep.py --lead leads/quantum.json \
        --set audience=cfo \
        --set ae="J. Chen" \
        --set meeting_date=2026-05-20

Generate a starter lead file from the new_prospect.py wizard, then run:

    python3 new_prospect.py "Acme Inc" --out leads/acme.py     # legacy .py wizard
    # OR write leads/acme.json by hand following the schema below.

Lead file schema (JSON)
-----------------------

    {
      "company":        "Required. Display name.",
      "ticker":         "Optional. Stock ticker if public.",
      "domain":         "Optional but strongly recommended. Company website domain.",
      "ae":             "Account Executive name (string).",
      "meeting_date":   "ISO date '2026-05-15' OR relative '+2' (days from today).",
      "out_dir":        "Output directory, e.g. 'examples/ACME'.",
      "coverage_days":  540,

      "industry_kinds": ["construction"],   // or ["healthcare", "finance", "general"]
      "include_linkedin": true,
      "include_federal":  true,
      "strategist":       true,
      "audience":         "cto",            // ceo | cto | cfo | coo | cro | generic

      "disambiguators": ["charleston", "south carolina", "sc"],
      "aliases":        ["Acme LLC", "Acme Inc"],
      "seed_urls":      ["https://acme.example/about/", ...]
    }
"""

from __future__ import annotations
import argparse
import json
import os
import re
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

# Load .env for API keys before pipeline imports.
try:
    from dotenv import load_dotenv, find_dotenv
    load_dotenv(find_dotenv(usecwd=True), override=False)
except ImportError:
    print("note: python-dotenv not installed — .env will not be auto-loaded.",
          file=sys.stderr)

# gpt-4o-mini default for cheap+fast extraction; override with env.
os.environ.setdefault("EXTRACTOR_MODEL_OVERRIDE", "gpt-4o-mini")

from pipeline import config  # noqa: E402
if os.environ.get("EXTRACTOR_MODEL_OVERRIDE"):
    config.EXTRACTOR_MODEL = os.environ["EXTRACTOR_MODEL_OVERRIDE"]

from pipeline.pipeline import run as run_pipeline  # noqa: E402


# ---------------------------------------------------------------------------
# Lead-file parsing
# ---------------------------------------------------------------------------

def _parse_meeting_date(value: Any) -> date:
    """Accept ISO date string or relative '+N' / '+N days' offset."""
    if isinstance(value, date):
        return value
    if not isinstance(value, str):
        raise ValueError(f"meeting_date must be a string, got {type(value)}")
    s = value.strip()
    # Relative: "+2", "+2 days", "today", "tomorrow"
    if s.lower() in ("today", "now"):
        return date.today()
    if s.lower() == "tomorrow":
        return date.today() + timedelta(days=1)
    m = re.match(r"^([+-]?\d+)(?:\s*days?)?$", s)
    if m:
        return date.today() + timedelta(days=int(m.group(1)))
    # Absolute ISO
    return date.fromisoformat(s)


def _coerce_value(raw: str) -> Any:
    """Used by --set k=v overrides. Try JSON parse, fall back to string."""
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def _apply_overrides(lead: dict, overrides: list[str]) -> dict:
    """Apply --set key=value overrides to the lead dict (returns a copy)."""
    out = dict(lead)
    for o in overrides:
        if "=" not in o:
            print(f"warning: ignoring malformed override {o!r} "
                  "(use key=value).", file=sys.stderr)
            continue
        key, _, raw = o.partition("=")
        out[key.strip()] = _coerce_value(raw.strip())
    return out


def load_lead(path: Path, overrides: list[str] = ()) -> dict:
    if not path.exists():
        raise FileNotFoundError(f"lead file not found: {path}")
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        raise SystemExit(f"ERROR: {path} is not valid JSON: {e}")
    if not isinstance(data, dict):
        raise SystemExit(f"ERROR: {path} top-level must be an object")
    if not data.get("company"):
        raise SystemExit(f"ERROR: {path} missing required field 'company'")
    return _apply_overrides(data, list(overrides))


# ---------------------------------------------------------------------------
# Pipeline invocation
# ---------------------------------------------------------------------------

def run_one(lead: dict) -> None:
    company = lead["company"]
    out_dir = Path(lead.get("out_dir") or f"examples/{re.sub(r'[^A-Za-z0-9]+', '_', company).upper()}")
    if not out_dir.is_absolute():
        out_dir = ROOT / out_dir
    meeting_date = _parse_meeting_date(lead.get("meeting_date", "+2"))

    print(f"\n=== {company} ===")
    print(f"  domain         : {lead.get('domain') or '(none)'}")
    print(f"  AE             : {lead.get('ae') or 'Account Executive'}")
    print(f"  meeting date   : {meeting_date.isoformat()}")
    print(f"  coverage       : {lead.get('coverage_days', 270)} days")
    print(f"  audience       : {lead.get('audience', 'generic')}")
    print(f"  strategist     : {lead.get('strategist', False)}")
    print(f"  out dir        : {out_dir}")
    print()

    vf = run_pipeline(
        company=company,
        ticker=lead.get("ticker"),
        domain=lead.get("domain"),
        ae=lead.get("ae", "Account Executive"),
        meeting_date=meeting_date,
        out_dir=out_dir,
        coverage_days=int(lead.get("coverage_days", 270)),
        industry_kinds=tuple(lead.get("industry_kinds") or ()),
        include_linkedin=bool(lead.get("include_linkedin", False)),
        include_federal=bool(lead.get("include_federal", False)),
        seed_urls=lead.get("seed_urls") or None,
        disambiguators=tuple(lead.get("disambiguators") or ()),
        aliases=tuple(lead.get("aliases") or ()),
        strategist=bool(lead.get("strategist", False)),
        audience=lead.get("audience", "generic"),
    )

    print(f"\nVerifier: {vf.verifier_log.quotes_passed}/"
          f"{vf.verifier_log.quotes_checked} quotes matched. "
          f"{len(vf.verifier_log.stripped)} stripped.")
    print(f"Brief:           {out_dir / 'brief.md'}")
    print(f"Audit trail:     {out_dir / 'facts.json'}")
    print(f"Evidence packet: {out_dir / 'sources.md'}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def preflight():
    if not os.environ.get("OPENAI_API_KEY"):
        print("ERROR: set OPENAI_API_KEY before running "
              "(via .env or `export OPENAI_API_KEY=...`).", file=sys.stderr)
        sys.exit(2)


def main():
    p = argparse.ArgumentParser(
        description="Run prospect_brief from a JSON lead file.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("--lead", action="append", default=[],
                   help="Path to a leads/<company>.json file. Repeat for multiple.")
    p.add_argument("--set", action="append", default=[],
                   metavar="KEY=VALUE",
                   help="Ad-hoc override for the lead file (e.g. "
                        "--set audience=cfo --set ae=\"J. Chen\"). "
                        "Repeat for multiple.")
    p.add_argument("--list-leads", action="store_true",
                   help="List the lead files under leads/ and exit.")
    args = p.parse_args()

    if not args.lead and not args.list_leads:
        p.error("supply --lead <path> at least once, or pass --list-leads.")

    if args.list_leads:
        leads_dir = ROOT / "leads"
        if not leads_dir.exists():
            print("(no leads/ directory)")
            return
        for f in sorted(leads_dir.glob("*.json")):
            try:
                d = json.loads(f.read_text())
                print(f"  {f.name:25s}  {d.get('company', '?')}")
            except Exception:
                print(f"  {f.name:25s}  (unparseable)")
        return

    preflight()

    for lead_path_str in args.lead:
        lead_path = Path(lead_path_str)
        if not lead_path.is_absolute():
            lead_path = ROOT / lead_path
        try:
            lead = load_lead(lead_path, overrides=args.set)
        except FileNotFoundError as e:
            print(f"ERROR: {e}", file=sys.stderr)
            sys.exit(2)
        try:
            run_one(lead)
        except KeyboardInterrupt:
            print("\n  ⚠ interrupted", file=sys.stderr)
            break
        except Exception as e:
            print(f"\n  ⚠ run failed for {lead.get('company','?')}: {e}",
                  file=sys.stderr)
            # Continue to next lead rather than crashing the whole batch.


if __name__ == "__main__":
    main()
