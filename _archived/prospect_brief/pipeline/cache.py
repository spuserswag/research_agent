"""Content-addressable disk cache.

Two namespaces:
  - "fetch":   URL → cleaned source text (saves the slow HTTP+trafilatura step)
  - "extract": (URL + content_hash + model + prompt_version) → SourceExtraction
               JSON (saves the OpenAI API call)

Files live under .cache/<namespace>/<sha1>.json and contain a small wrapper:
{
  "key":          "<the cache key, plaintext>",
  "stored_at":    "<ISO timestamp>",
  "ttl_days":     7,
  "namespace":    "fetch" | "extract",
  "value":        <the cached payload, JSON>
}

Reads honor TTL. Writes are atomic (write to .tmp, then rename). The whole
cache can be cleared with `clear_all()` or namespace-by-namespace.

This is a deliberately tiny module — no third-party dependency, no SQLite,
no pickle. JSON files are easy to inspect by hand when debugging "why didn't
my brief refresh?"
"""

from __future__ import annotations
import hashlib
import json
import logging
import os
import tempfile
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger(__name__)

# Where the cache lives. Override with env var if you want it outside the repo.
_CACHE_ROOT_ENV = "PROSPECT_BRIEF_CACHE_DIR"
_DEFAULT_ROOT = Path(__file__).resolve().parent.parent / ".cache"


def cache_root() -> Path:
    p = Path(os.environ.get(_CACHE_ROOT_ENV, _DEFAULT_ROOT))
    p.mkdir(parents=True, exist_ok=True)
    return p


# ---------------------------------------------------------------------------
# Key builders
# ---------------------------------------------------------------------------

def _hash(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()


# Bump this whenever fetch.py's extraction logic changes in a way that
# would make old cached text wrong (e.g., footer-stripping fix). Old
# entries become unreachable; new fetches populate the cache fresh.
FETCH_VERSION = "v2-2026-05-08-keep-footer"


def fetch_cache_key(url: str) -> str:
    return f"{url}|{FETCH_VERSION}"


def extract_cache_key(
    *, url: str, text_hash: str, model: str, prompt_version: str,
) -> str:
    return f"{url}|{text_hash}|{model}|{prompt_version}"


def text_hash(text: str) -> str:
    """Stable content fingerprint for source text. Used so that re-fetching a
    page with new content invalidates the old extraction result automatically."""
    return _hash(text or "")


# ---------------------------------------------------------------------------
# Read / write
# ---------------------------------------------------------------------------

def _path_for(namespace: str, key: str) -> Path:
    return cache_root() / namespace / f"{_hash(key)}.json"


# Default TTL per namespace, in days. Override per call if needed.
DEFAULT_TTL = {
    "fetch":      timedelta(days=7),
    "extract":    timedelta(days=30),
    "strategist": timedelta(days=14),
}


def cache_get(
    namespace: str,
    key: str,
    *,
    ttl: Optional[timedelta] = None,
) -> Optional[Any]:
    """Return the cached value, or None if missing/expired."""
    path = _path_for(namespace, key)
    if not path.exists():
        return None
    try:
        envelope = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError) as e:
        log.warning("cache: corrupt entry %s: %s", path, e)
        return None
    stored_at_str = envelope.get("stored_at", "")
    try:
        stored_at = datetime.fromisoformat(stored_at_str)
    except ValueError:
        return None
    effective_ttl = ttl or DEFAULT_TTL.get(namespace, timedelta(days=7))
    if datetime.now(timezone.utc) - stored_at > effective_ttl:
        return None    # expired
    return envelope.get("value")


def cache_put(namespace: str, key: str, value: Any) -> None:
    """Atomically write a cache entry."""
    path = _path_for(namespace, key)
    path.parent.mkdir(parents=True, exist_ok=True)
    envelope = {
        "key": key,
        "namespace": namespace,
        "stored_at": datetime.now(timezone.utc).isoformat(),
        "value": value,
    }
    # Atomic write: tmp file in same dir, then rename.
    tmp = tempfile.NamedTemporaryFile(
        mode="w", suffix=".tmp", dir=path.parent, delete=False, encoding="utf-8",
    )
    try:
        json.dump(envelope, tmp, ensure_ascii=False)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp.close()
        os.replace(tmp.name, path)
    except Exception:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
        raise


def clear_all() -> int:
    """Wipe the entire cache. Returns count of files removed."""
    root = cache_root()
    if not root.exists():
        return 0
    n = 0
    for p in root.rglob("*.json"):
        try:
            p.unlink()
            n += 1
        except OSError:
            pass
    return n


def stats() -> dict[str, dict[str, int]]:
    """Quick {namespace: {count, bytes}} summary for diagnostics."""
    root = cache_root()
    out: dict[str, dict[str, int]] = {}
    if not root.exists():
        return out
    for ns_dir in root.iterdir():
        if not ns_dir.is_dir():
            continue
        n, b = 0, 0
        for p in ns_dir.glob("*.json"):
            n += 1
            try:
                b += p.stat().st_size
            except OSError:
                pass
        out[ns_dir.name] = {"count": n, "bytes": b}
    return out


# ---------------------------------------------------------------------------
# Module-level kill switch — set CACHE_DISABLED=1 in env to bypass all reads
# (writes still happen, so the next run-without-the-flag is fast).
# ---------------------------------------------------------------------------

def reads_disabled() -> bool:
    return os.environ.get("CACHE_DISABLED", "").lower() in ("1", "true", "yes")
