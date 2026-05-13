#!/usr/bin/env python3
"""
apollo.py — pull Apollo.io data for every company in companies.csv.

Standalone script. Does not depend on or modify the rest of the crawler code.

Pipeline per row:
  1. Read company name from CSV (Exhibitor column) and the description.
  2. Generate name candidates: the original name, plus splits on ",", " and ",
     " & " for cells that smash multiple companies together
     (e.g. "aec+tech, AI in AEC and Neostack" → 3 candidates).
  3. For each candidate, hit Apollo's Organization Search to resolve it to an
     org, and score the match against the input description (industry +
     keyword overlap, name match) to flag wrong-company hits.
  4. For accepted matches, hit Apollo's Organization Enrichment to pull the
     full payload (industry, headcount, funding, tech stack, revenue, etc.).
  5. Write everything to apollo_output.json (full payloads + per-match
     confidence) and apollo_output.csv (one flat row per match, with a
     match_confidence column so you can review low-confidence hits by hand).

Apollo API references:
  - Organization Search:     POST https://api.apollo.io/api/v1/mixed_companies/search
  - Organization Enrichment: GET  https://api.apollo.io/api/v1/organizations/enrich

Auth: set APOLLO_API_KEY in your environment (or in a .env file next to this
script). Header: x-api-key.

Cloudflare on api.apollo.io blocks the default Python urllib User-Agent; we
send a normal Chrome UA. Override with APOLLO_USER_AGENT if needed.

Usage:
  export APOLLO_API_KEY=your_key
  python3 apollo.py
  python3 apollo.py --csv companies.csv --out-json apollo_output.json --out-csv apollo_output.csv
  python3 apollo.py --resume          # skip companies already in the JSON output
  python3 apollo.py --limit 5         # only process the first 5 rows (useful for testing)
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlencode

import urllib.request
import urllib.error


APOLLO_BASE = "https://api.apollo.io/api/v1"
SEARCH_URL = f"{APOLLO_BASE}/mixed_companies/search"
ENRICH_URL = f"{APOLLO_BASE}/organizations/enrich"

DEFAULT_CSV = "companies.csv"
DEFAULT_OUT_JSON = "apollo_output.json"
DEFAULT_OUT_CSV = "apollo_output.csv"

REQUEST_DELAY_SECONDS = 0.6
MAX_RETRIES = 3
RETRY_BACKOFF_SECONDS = 5


# --------------------------------------------------------------------------- #
# .env loader (no external deps)
# --------------------------------------------------------------------------- #

def load_dotenv(path: Path) -> None:
    """Minimal .env loader — only sets vars not already in os.environ."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


# --------------------------------------------------------------------------- #
# HTTP helpers (stdlib only)
# --------------------------------------------------------------------------- #

class ApolloError(Exception):
    pass


def _request(
    method: str,
    url: str,
    api_key: str,
    *,
    params: Optional[dict[str, Any]] = None,
    body: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Make an HTTP request to Apollo with retries. Returns parsed JSON."""
    if params:
        url = f"{url}?{urlencode(params)}"

    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {
        # Cloudflare on api.apollo.io blocks the default "Python-urllib/3.x"
        # User-Agent (error 1010 / browser_signature_banned). Send a normal one.
        "User-Agent": os.environ.get(
            "APOLLO_USER_AGENT",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36",
        ),
        "accept": "application/json",
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
        "x-api-key": api_key,
    }

    last_err: Optional[Exception] = None
    for attempt in range(1, MAX_RETRIES + 1):
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            body_text = ""
            try:
                body_text = e.read().decode("utf-8", errors="replace")
            except Exception:
                pass
            if e.code == 429 or 500 <= e.code < 600:
                last_err = ApolloError(f"HTTP {e.code} on {url}: {body_text[:200]}")
                sleep_for = RETRY_BACKOFF_SECONDS * attempt
                print(f"  ! {e.code} — retrying in {sleep_for}s (attempt {attempt}/{MAX_RETRIES})", file=sys.stderr)
                time.sleep(sleep_for)
                continue
            raise ApolloError(f"HTTP {e.code} on {url}: {body_text[:500]}") from e
        except urllib.error.URLError as e:
            last_err = ApolloError(f"network error on {url}: {e}")
            time.sleep(RETRY_BACKOFF_SECONDS * attempt)
            continue

    raise last_err or ApolloError(f"failed after {MAX_RETRIES} attempts: {url}")


def apollo_search_company(api_key: str, name: str) -> Optional[dict[str, Any]]:
    """
    Use Apollo's Organization Search to resolve a company name.
    Returns the first organization dict, or None if nothing found.
    """
    body = {
        "q_organization_name": name,
        "page": 1,
        "per_page": 5,
    }
    payload = _request("POST", SEARCH_URL, api_key, body=body)

    orgs = payload.get("organizations") or payload.get("accounts") or []
    if not orgs:
        return None

    target = name.strip().lower()
    for org in orgs:
        if (org.get("name") or "").strip().lower() == target:
            return org
    return orgs[0]


def apollo_enrich_company(api_key: str, domain: str) -> Optional[dict[str, Any]]:
    """Use Apollo's Organization Enrichment to pull the full payload."""
    payload = _request("GET", ENRICH_URL, api_key, params={"domain": domain})
    return payload.get("organization")


# --------------------------------------------------------------------------- #
# Name splitting
# --------------------------------------------------------------------------- #

# Common company-name suffixes — when splitting on ",", a piece like "Inc"
# is almost always the tail of the previous part, not a separate company.
SUFFIX_FRAGMENTS = {
    "inc", "inc.", "llc", "llc.", "ltd", "ltd.", "co", "co.", "corp",
    "corp.", "corporation", "company", "limited", "plc", "gmbh", "ag",
}


def normalize_name(name: str) -> str:
    """Strip leading punctuation/whitespace garbage like '/slantis' → 'slantis'."""
    cleaned = re.sub(r"^[^\w&+]+", "", name).strip()
    return cleaned or name


def split_compound_name(name: str) -> list[str]:
    """
    Try to split a CSV cell that bundles multiple companies into one string,
    e.g. 'aec+tech, AI in AEC and Neostack' → ['aec+tech', 'AI in AEC', 'Neostack'].

    Returns the original (in a 1-element list) if no compound delimiters apply.
    """
    parts = [name]
    for delim in [",", " and ", " & "]:
        new: list[str] = []
        for p in parts:
            for piece in re.split(re.escape(delim), p, flags=re.IGNORECASE):
                piece = piece.strip()
                if piece and piece.lower() not in SUFFIX_FRAGMENTS:
                    new.append(piece)
        parts = new

    seen: set[str] = set()
    out: list[str] = []
    for p in parts:
        key = p.lower()
        if key not in seen:
            seen.add(key)
            out.append(p)
    return out or [name]


def name_candidates(name: str) -> list[str]:
    """
    Build the full list of name variants to query Apollo with: normalized
    original, compound-split parts, and (for 'Foo/Bar' product slashes) the
    left-of-slash piece as a fallback.
    """
    out: list[str] = []
    seen: set[str] = set()

    def add(c: str) -> None:
        c = c.strip()
        if not c:
            return
        key = c.lower()
        if key in seen:
            return
        seen.add(key)
        out.append(c)

    add(name)
    add(normalize_name(name))
    for p in split_compound_name(normalize_name(name)):
        add(p)
    # 'Iconic BIM/Guardian' → also try 'Iconic BIM' (company before product)
    if "/" in name:
        left = name.split("/", 1)[0].strip()
        if left:
            add(left)
            add(normalize_name(left))

    return out


# --------------------------------------------------------------------------- #
# Match scoring (catches wrong-company hits)
# --------------------------------------------------------------------------- #

# Words too generic to count as evidence of a domain match.
STOPWORDS = {
    "the", "and", "for", "with", "that", "this", "from", "are", "was", "were",
    "has", "have", "had", "into", "their", "they", "them", "its", "his", "her",
    "but", "not", "can", "will", "all", "any", "your", "our", "you", "out",
    "over", "such", "more", "than", "also", "who", "what", "when", "where",
    "how", "why", "use", "used", "uses", "using", "based", "company", "companies",
    "platform", "platforms", "solution", "solutions", "service", "services",
    "software", "provider", "providers", "specializes", "including", "include",
    "tool", "tools", "industry", "industries", "global", "worldwide", "leading",
    "across", "within", "between", "through", "designed", "design",
}


def tokens(text: str) -> set[str]:
    """Lowercase 3+ letter words from text, minus stopwords."""
    return {t for t in re.findall(r"[a-z][a-z]{2,}", (text or "").lower()) if t not in STOPWORDS}


def score_match(queried_as: str, input_desc: str, org: dict[str, Any]) -> tuple[float, list[str]]:
    """
    Score how confident we are that `org` is the right company for the query.
    Returns (score in [0, 1], list of human-readable notes).
    """
    notes: list[str] = []
    score = 0.0

    matched_name = (org.get("name") or "").strip().lower()
    queried = queried_as.strip().lower()

    # --- Name signal ---
    if matched_name and matched_name == queried:
        score += 0.4
        notes.append("name:exact")
    elif matched_name and queried and (queried in matched_name or matched_name in queried):
        score += 0.2
        notes.append(f"name:partial ({matched_name!r} vs {queried!r})")
    else:
        notes.append(f"name:mismatch ({matched_name!r} vs {queried!r})")

    desc_toks = tokens(input_desc)

    # --- Apollo's classification (industry + keywords) — strongest signal ---
    keywords = org.get("keywords") or []
    if isinstance(keywords, list):
        kw_text = " ".join(str(k) for k in keywords)
    else:
        kw_text = ""
    class_text = " ".join(filter(None, [str(org.get("industry") or ""), kw_text]))
    class_toks = tokens(class_text)
    class_overlap = desc_toks & class_toks

    if class_overlap:
        boost = min(0.4, 0.08 * len(class_overlap))
        score += boost
        sample = ",".join(sorted(class_overlap)[:5])
        notes.append(f"class_overlap:{len(class_overlap)} ({sample})")
    elif desc_toks and class_toks and len(desc_toks) >= 3:
        # Apollo classifies this org in a totally different space than the
        # description suggests — strong negative signal (catches the
        # "Acelab → Korean automotive" case).
        score -= 0.3
        notes.append("class_mismatch: industry/keywords don't match description")

    # --- short_description overlap (weaker, since Apollo sometimes pastes in
    #     text from the right company even when the metadata is wrong) ---
    sd_toks = tokens(org.get("short_description") or "")
    sd_overlap = desc_toks & sd_toks
    if sd_overlap:
        score += min(0.2, 0.04 * len(sd_overlap))
        notes.append(f"desc_overlap:{len(sd_overlap)}")

    return max(0.0, min(1.0, score)), notes


def confidence_bucket(score: float) -> str:
    if score >= 0.6:
        return "high"
    if score >= 0.3:
        return "medium"
    return "low"


# --------------------------------------------------------------------------- #
# Resolve a single CSV row to one or more Apollo matches
# --------------------------------------------------------------------------- #

def resolve_company(
    api_key: str,
    name: str,
    description: str,
    delay: float,
) -> list[dict[str, Any]]:
    """
    Try the original name plus split components, enrich each hit, then score
    using the enriched payload (industry/keywords are only present in the
    enrichment response, not the bare search response). Returns a list of
    accepted match dicts.
    """
    raw_hits: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    for cand in name_candidates(name):
        try:
            hit = apollo_search_company(api_key, cand)
        except ApolloError as e:
            raw_hits.append({"queried_as": cand, "error": str(e), "search_result": None})
            time.sleep(delay)
            continue
        time.sleep(delay)
        if not hit:
            continue

        # Skip a candidate that resolved to an org we already evaluated via
        # another candidate name — saves an enrichment credit.
        org_id = str(hit.get("id") or "")
        if org_id and org_id in seen_ids:
            continue
        if org_id:
            seen_ids.add(org_id)

        # Resolve a domain so we can enrich.
        domain = hit.get("primary_domain") or hit.get("domain") or ""
        if not domain and hit.get("website_url"):
            url = hit["website_url"]
            domain = (
                url.replace("https://", "").replace("http://", "")
                   .split("/")[0].lstrip("www.")
            )

        enriched: Optional[dict[str, Any]] = None
        enrich_err: Optional[str] = None
        if domain:
            try:
                enriched = apollo_enrich_company(api_key, domain)
            except ApolloError as e:
                enrich_err = f"enrich: {e}"
            time.sleep(delay)

        # Score against the enrichment payload (richer); fall back to the
        # search hit if enrichment failed or had no domain to query.
        score, score_notes = score_match(cand, description, enriched or hit)

        raw_hits.append({
            "queried_as": cand,
            "search_result": hit,
            "enrichment": enriched,
            "matched_name": hit.get("name", ""),
            "match_score": round(score, 3),
            "match_confidence": confidence_bucket(score),
            "confidence_notes": score_notes,
            "error": enrich_err,
        })

    successful = [h for h in raw_hits if h.get("search_result")]

    # 1. Original-name hit at high confidence wins outright — drop split
    #    candidates so we don't pollute the row with sub-matches.
    original_hit = next(
        (h for h in successful if h["queried_as"] == name and h.get("match_score", 0) >= 0.6),
        None,
    )
    if original_hit:
        return [original_hit]

    # 2. Otherwise keep every hit >= medium so a compound row can produce
    #    multiple matches.
    keep = [h for h in successful if h.get("match_score", 0) >= 0.3]

    # 3. If nothing crossed the bar, keep the single best low-confidence hit
    #    so the user has something to eyeball rather than an empty row.
    if not keep and successful:
        keep = [max(successful, key=lambda h: h.get("match_score", 0))]

    return keep


# --------------------------------------------------------------------------- #
# CSV output
# --------------------------------------------------------------------------- #

CSV_FIELDS = [
    "input_name",
    "sponsor_level",
    "input_description",
    "queried_as",
    "match_confidence",
    "match_score",
    "confidence_notes",
    "matched_name",
    "domain",
    "website_url",
    "linkedin_url",
    "twitter_url",
    "facebook_url",
    "industry",
    "estimated_num_employees",
    "annual_revenue",
    "founded_year",
    "city",
    "state",
    "country",
    "phone",
    "short_description",
    "keywords",
    "technologies",
    "total_funding",
    "latest_funding_stage",
    "latest_funding_date",
    "apollo_id",
    "error",
]


def flatten_match(input_row: dict[str, str], match: Optional[dict[str, Any]]) -> dict[str, str]:
    """Project a single match into a flat CSV row."""
    out: dict[str, str] = {f: "" for f in CSV_FIELDS}
    out["input_name"] = input_row.get("Exhibitor", "")
    out["sponsor_level"] = input_row.get("Sponsor Level", "")
    out["input_description"] = input_row.get("Description", "")

    if not match:
        return out

    out["queried_as"] = str(match.get("queried_as", "") or "")
    out["match_confidence"] = str(match.get("match_confidence", "") or "")
    out["match_score"] = str(match.get("match_score", "") or "")
    notes = match.get("confidence_notes") or []
    if isinstance(notes, list):
        out["confidence_notes"] = "; ".join(str(n) for n in notes)
    if match.get("error"):
        out["error"] = str(match["error"])

    org = match.get("enrichment") or match.get("search_result")
    if not org:
        return out

    out["matched_name"] = str(org.get("name", "") or "")
    out["domain"] = str(org.get("primary_domain") or org.get("domain") or "")
    out["website_url"] = str(org.get("website_url", "") or "")
    out["linkedin_url"] = str(org.get("linkedin_url", "") or "")
    out["twitter_url"] = str(org.get("twitter_url", "") or "")
    out["facebook_url"] = str(org.get("facebook_url", "") or "")
    out["industry"] = str(org.get("industry", "") or "")
    out["estimated_num_employees"] = str(org.get("estimated_num_employees", "") or "")
    out["annual_revenue"] = str(org.get("annual_revenue") or org.get("organization_revenue") or "")
    out["founded_year"] = str(org.get("founded_year", "") or "")
    out["phone"] = str(org.get("phone") or org.get("sanitized_phone") or "")
    out["short_description"] = str(org.get("short_description", "") or "")
    out["apollo_id"] = str(org.get("id", "") or "")

    out["city"] = str(org.get("city", "") or "")
    out["state"] = str(org.get("state", "") or "")
    out["country"] = str(org.get("country", "") or "")

    keywords = org.get("keywords") or []
    if isinstance(keywords, list):
        out["keywords"] = "; ".join(str(k) for k in keywords[:25])

    techs = org.get("technologies") or org.get("current_technologies") or []
    if isinstance(techs, list):
        names = []
        for t in techs:
            if isinstance(t, dict):
                names.append(str(t.get("name") or t.get("uid") or ""))
            else:
                names.append(str(t))
        out["technologies"] = "; ".join(n for n in names if n)[:2000]

    funding_events = org.get("funding_events") or []
    out["total_funding"] = str(org.get("total_funding") or org.get("total_funding_printed") or "")
    if funding_events and isinstance(funding_events, list):
        latest = funding_events[0]
        if isinstance(latest, dict):
            out["latest_funding_stage"] = str(latest.get("type") or latest.get("name") or "")
            out["latest_funding_date"] = str(latest.get("date") or "")
    elif org.get("latest_funding_round_date") or org.get("latest_funding_stage"):
        out["latest_funding_stage"] = str(org.get("latest_funding_stage", "") or "")
        out["latest_funding_date"] = str(org.get("latest_funding_round_date", "") or "")

    return out


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Pull Apollo.io data for companies in a CSV.")
    p.add_argument("--csv", default=DEFAULT_CSV, help=f"input CSV path (default: {DEFAULT_CSV})")
    p.add_argument("--out-json", default=DEFAULT_OUT_JSON, help=f"output JSON path (default: {DEFAULT_OUT_JSON})")
    p.add_argument("--out-csv", default=DEFAULT_OUT_CSV, help=f"output flattened CSV path (default: {DEFAULT_OUT_CSV})")
    p.add_argument("--resume", action="store_true", help="skip companies already in the JSON output")
    p.add_argument("--limit", type=int, default=0, help="only process the first N rows (0 = all)")
    p.add_argument("--delay", type=float, default=REQUEST_DELAY_SECONDS, help="seconds to wait between API calls")
    p.add_argument(
        "--rescore-only",
        action="store_true",
        help="don't hit Apollo; just recompute match scores on existing JSON output and rewrite both files",
    )
    return p.parse_args()


def rescore_only(out_json_path: Path, out_csv_path: Path) -> int:
    """Recompute scores in place using the enrichment data already on disk."""
    if not out_json_path.exists():
        print(f"ERROR: no existing JSON at {out_json_path}", file=sys.stderr)
        return 2
    with out_json_path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    rescored = 0
    for entry in data:
        desc = entry.get("input_description", "")
        for m in entry.get("matches") or []:
            org = m.get("enrichment") or m.get("search_result")
            if not org:
                continue
            score, notes = score_match(m.get("queried_as", entry.get("input_name", "")), desc, org)
            m["match_score"] = round(score, 3)
            m["match_confidence"] = confidence_bucket(score)
            m["confidence_notes"] = notes
            rescored += 1

    with out_json_path.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    with out_csv_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        writer.writeheader()
        for entry in data:
            input_row = {
                "Exhibitor": entry.get("input_name", ""),
                "Sponsor Level": entry.get("input_sponsor_level", ""),
                "Description": entry.get("input_description", ""),
            }
            matches = entry.get("matches") or []
            if matches:
                for m in matches:
                    writer.writerow(flatten_match(input_row, m))
            else:
                empty = flatten_match(input_row, None)
                if entry.get("error"):
                    empty["error"] = str(entry["error"])
                writer.writerow(empty)

    print(f"Rescored {rescored} matches across {len(data)} rows.")
    print(f"Wrote:\n  {out_json_path}\n  {out_csv_path}")
    return 0


def main() -> int:
    script_dir = Path(__file__).resolve().parent
    load_dotenv(script_dir / ".env")

    args = parse_args()

    out_json_path = Path(args.out_json)
    if not out_json_path.is_absolute():
        out_json_path = script_dir / out_json_path
    out_csv_path = Path(args.out_csv)
    if not out_csv_path.is_absolute():
        out_csv_path = script_dir / out_csv_path

    if args.rescore_only:
        return rescore_only(out_json_path, out_csv_path)

    api_key = os.environ.get("APOLLO_API_KEY", "").strip()
    if not api_key:
        print("ERROR: set APOLLO_API_KEY in your environment or in a .env file.", file=sys.stderr)
        return 2

    csv_path = Path(args.csv)
    if not csv_path.is_absolute():
        csv_path = script_dir / csv_path
    if not csv_path.exists():
        print(f"ERROR: CSV not found: {csv_path}", file=sys.stderr)
        return 2

    existing: dict[str, dict[str, Any]] = {}
    if args.resume and out_json_path.exists():
        try:
            with out_json_path.open("r", encoding="utf-8") as f:
                prior = json.load(f)
            for entry in prior:
                key = entry.get("input_name") or ""
                if key:
                    existing[key] = entry
            print(f"Resume: loaded {len(existing)} prior entries from {out_json_path.name}")
        except Exception as e:
            print(f"WARN: could not load prior JSON ({e}); starting fresh", file=sys.stderr)

    results: list[dict[str, Any]] = list(existing.values())

    with csv_path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    if args.limit and args.limit > 0:
        rows = rows[: args.limit]

    print(f"Processing {len(rows)} companies from {csv_path.name}")

    for idx, row in enumerate(rows, 1):
        name = (row.get("Exhibitor") or "").strip()
        description = (row.get("Description") or "").strip()
        if not name:
            continue

        if args.resume and name in existing:
            print(f"[{idx}/{len(rows)}] SKIP (already done): {name}")
            continue

        print(f"[{idx}/{len(rows)}] {name}")

        entry: dict[str, Any] = {
            "input_name": name,
            "input_sponsor_level": row.get("Sponsor Level", ""),
            "input_description": description,
            "matches": [],
            "error": None,
        }

        try:
            matches = resolve_company(api_key, name, description, args.delay)
            entry["matches"] = matches
            if not matches:
                entry["error"] = "no Apollo match"
                print("   no Apollo match")
            else:
                for m in matches:
                    print(
                        f"   [{m.get('match_confidence', '?'):>6}] "
                        f"{m.get('queried_as', '')!r} → "
                        f"{(m.get('search_result') or {}).get('name', '')!r} "
                        f"<{(m.get('search_result') or {}).get('primary_domain', '')}> "
                        f"score={m.get('match_score', 0)}"
                    )
        except ApolloError as e:
            entry["error"] = str(e)
            print(f"   ERROR: {e}", file=sys.stderr)
        except Exception as e:  # pragma: no cover
            entry["error"] = f"unexpected: {e}"
            print(f"   UNEXPECTED ERROR: {e}", file=sys.stderr)

        # Replace any prior entry for this name, then append
        results = [r for r in results if r.get("input_name") != name]
        results.append(entry)

        with out_json_path.open("w", encoding="utf-8") as f:
            json.dump(results, f, indent=2, ensure_ascii=False)

    # Flat CSV: one row per match (or one empty-match row if nothing matched).
    with out_csv_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        writer.writeheader()
        for entry in results:
            input_row = {
                "Exhibitor": entry.get("input_name", ""),
                "Sponsor Level": entry.get("input_sponsor_level", ""),
                "Description": entry.get("input_description", ""),
            }
            matches = entry.get("matches") or []
            if matches:
                for m in matches:
                    writer.writerow(flatten_match(input_row, m))
            else:
                empty = flatten_match(input_row, None)
                if entry.get("error"):
                    empty["error"] = str(entry["error"])
                writer.writerow(empty)

    print(f"\nDone. Wrote:\n  {out_json_path}\n  {out_csv_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
