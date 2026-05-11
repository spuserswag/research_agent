"""LLM-driven structured extraction (OpenAI).

For each source, send the cleaned text + the source metadata to an OpenAI
chat completion with the extractor system prompt. We use JSON-mode
(`response_format={"type": "json_object"}`) so the model returns a parseable
JSON object directly. We validate it with Pydantic; any malformed output
is dropped (not retried with synthesized values — the verifier catches
hallucinated quotes downstream regardless).
"""

from __future__ import annotations
import json
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import List

from openai import OpenAI
from pydantic import ValidationError, BaseModel

from .schema import (
    Source, SourceExtraction,
    LeadershipChange, FundingEvent, ExecStatement, HiringSignal,
    FinancialSignal, ProductLaunch, CustomerOrPartnership,
    LitigationOrRegulatory, CompanyProfile,
)
from . import config
from . import cache as _cache

# Bumped whenever extractor.md or schema fields change in a way that would
# invalidate cached extractions. Read by the cache key builder.
PROMPT_VERSION = "v11-2026-05-08-hq-vs-office-strict"


# Map fact-list field name -> the Pydantic model that validates each item.
_FACT_MODELS: dict[str, type[BaseModel]] = {
    "leadership_changes": LeadershipChange,
    "funding_events": FundingEvent,
    "exec_statements": ExecStatement,
    "hiring_signals": HiringSignal,
    "financial_signals": FinancialSignal,
    "product_launches": ProductLaunch,
    "customer_or_partnership": CustomerOrPartnership,
    "litigation_or_regulatory": LitigationOrRegulatory,
    "company_profile": CompanyProfile,
}


def _safe_validate_facts(obj: dict, source_id: str) -> SourceExtraction:
    """Validate each fact individually; drop the malformed ones, keep the rest.

    The whole-object Pydantic validation is too brittle for gpt-4o-mini's
    occasional shape drift (string-instead-of-list, missing verbatim_quote,
    free-form dates). Validating per-fact keeps the source's good facts even
    when one or two are bad.
    """
    valid_lists: dict[str, list] = {kind: [] for kind in _FACT_MODELS}
    for kind, model_cls in _FACT_MODELS.items():
        items = obj.get(kind, []) or []
        if not isinstance(items, list):
            log.warning("[%s] %s: expected list, got %s — skipping",
                        source_id, kind, type(items).__name__)
            continue
        for i, item in enumerate(items):
            if not isinstance(item, dict):
                continue
            item.setdefault("source_id", source_id)
            try:
                valid_lists[kind].append(model_cls.model_validate(item))
            except ValidationError as e:
                # Capture the FIRST error reason briefly, drop the fact.
                err = e.errors()[0] if e.errors() else {}
                reason = err.get("type", "unknown")
                loc = ".".join(str(x) for x in err.get("loc", []))
                log.info("[%s] dropped %s[%d]: %s at %s",
                         source_id, kind, i, reason, loc)
    return SourceExtraction(source_id=source_id, **valid_lists)

log = logging.getLogger(__name__)

PROMPT_PATH = Path(__file__).parent.parent / "prompts" / "extractor.md"


def _system_prompt() -> str:
    base = PROMPT_PATH.read_text()
    # OpenAI JSON-mode requires the word "json" in the prompt.
    if "json" not in base.lower():
        base += "\n\nReturn JSON."
    return base


def _user_message(source: Source) -> str:
    # Truncate text if huge — extractor only needs first ~30k chars to find
    # the bulk of facts. Filings can be enormous; we trade recall for cost.
    text = (source.text or "")[:30_000]
    return (
        "SOURCE METADATA:\n"
        f"source_id: {source.id}\n"
        f"source_type: {source.type}\n"
        f"url: {source.url}\n"
        f"publisher: {source.publisher}\n"
        f"publish_date: {source.publish_date.isoformat() if source.publish_date else 'unknown'}\n"
        f"title: {source.title}\n"
        "\n"
        "SOURCE TEXT:\n"
        "-----\n"
        f"{text}\n"
        "-----\n"
        "\n"
        "Return a JSON object conforming to the SourceExtraction schema. "
        "Every fact MUST include source_id and verbatim_quote ≤ 15 words. "
        "Empty arrays are fine. Do not include any text outside the JSON."
    )


# Per-call timeout (seconds). Slow networks + a hung connection used to
# stall the whole pipeline; with this set, a single bad call fails fast and
# the source is silently skipped (the verifier just won't see its facts).
PER_CALL_TIMEOUT_S = float(os.environ.get("EXTRACTOR_TIMEOUT_S", "30"))

# How many sources to extract in parallel. The OpenAI API tolerates dozens of
# concurrent requests at a typical user's rate limit; 8 is a safe default.
EXTRACTOR_CONCURRENCY = int(os.environ.get("EXTRACTOR_CONCURRENCY", "8"))


def _make_client() -> OpenAI:
    # Allow OPENAI_BASE_URL override (e.g., proxy, Azure-compatible endpoint).
    base_url = os.environ.get("OPENAI_BASE_URL")
    kwargs: dict = {"timeout": PER_CALL_TIMEOUT_S, "max_retries": 1}
    if base_url:
        kwargs["base_url"] = base_url
    return OpenAI(**kwargs)


def extract_one(client: OpenAI, source: Source) -> SourceExtraction:
    """Run extractor on a single source. Returns empty SourceExtraction on failure."""
    # Cache lookup: key is (url, content_hash, model, prompt_version) so any
    # change to source text or prompt invalidates the entry automatically.
    cache_key = _cache.extract_cache_key(
        url=source.url,
        text_hash=_cache.text_hash(source.text or ""),
        model=config.EXTRACTOR_MODEL,
        prompt_version=PROMPT_VERSION,
    )
    if not _cache.reads_disabled():
        hit = _cache.cache_get("extract", cache_key)
        if hit is not None:
            # Force source_id to current source so the verifier can match
            # this extraction back to the source. Belt-and-suspenders even
            # though _stable_id should make IDs deterministic now.
            hit["source_id"] = source.id
            for items in hit.values():
                if isinstance(items, list):
                    for item in items:
                        if isinstance(item, dict):
                            item["source_id"] = source.id
            try:
                return SourceExtraction.model_validate(hit)
            except ValidationError:
                pass    # corrupt entry, ignore and re-extract

    try:
        resp = client.chat.completions.create(
            model=config.EXTRACTOR_MODEL,
            max_tokens=config.EXTRACTOR_MAX_TOKENS,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": _system_prompt()},
                {"role": "user", "content": _user_message(source)},
            ],
        )
        raw = resp.choices[0].message.content or ""
    except Exception as e:
        log.warning("extractor LLM call failed for %s: %s", source.id, e)
        return SourceExtraction(source_id=source.id)

    # JSON-mode usually returns clean JSON, but strip code fences just in case.
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.lower().startswith("json"):
            raw = raw[4:].lstrip()

    try:
        obj = json.loads(raw)
    except json.JSONDecodeError as e:
        log.warning("extractor returned non-JSON for %s: %s", source.id, e)
        return SourceExtraction(source_id=source.id)

    # Force source_id to match (ignore any value the model echoed).
    obj["source_id"] = source.id
    for key, items in list(obj.items()):
        if isinstance(items, list):
            for item in items:
                if isinstance(item, dict):
                    item["source_id"] = source.id

    # Per-fact validation: drop bad facts but keep the source's good ones.
    result = _safe_validate_facts(obj, source.id)
    # Persist the validated result so re-runs don't pay the LLM call again.
    try:
        _cache.cache_put("extract", cache_key, result.model_dump(mode="json"))
    except Exception as e:
        log.info("cache put failed (non-fatal): %s", e)
    return result


def extract_all(sources: List[Source]) -> List[SourceExtraction]:
    """Run extract_one over every source in parallel.

    Threads share one OpenAI client (it's threadsafe). Failures in any single
    extraction return an empty SourceExtraction so they don't block the whole
    pipeline. Order of results matches the input order so downstream code is
    unaffected.
    """
    if not sources:
        return []

    client = _make_client()
    results: List[SourceExtraction] = [SourceExtraction(source_id=s.id) for s in sources]
    n = len(sources)
    workers = min(EXTRACTOR_CONCURRENCY, n)

    print(f"  extracting {n} source(s) in parallel "
          f"(workers={workers}, per-call timeout={PER_CALL_TIMEOUT_S:.0f}s)…",
          flush=True)
    t0 = time.monotonic()

    def _do_one(idx_src):
        idx, s = idx_src
        t1 = time.monotonic()
        try:
            res = extract_one(client, s)
        except KeyboardInterrupt:
            raise
        except Exception as e:
            log.warning("extract_one crashed for %s: %s", s.id, e)
            res = SourceExtraction(source_id=s.id)
        elapsed = time.monotonic() - t1
        n_facts = sum(
            len(getattr(res, k)) for k in (
                "leadership_changes", "funding_events", "exec_statements",
                "hiring_signals", "financial_signals", "product_launches",
                "customer_or_partnership", "litigation_or_regulatory",
                "company_profile",
            )
        )
        print(f"    [{idx+1}/{n}] {s.type:18s} {n_facts} fact(s) in "
              f"{elapsed:4.1f}s — {s.url[:70]}", flush=True)
        return idx, res

    try:
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futures = [ex.submit(_do_one, (i, s)) for i, s in enumerate(sources)]
            for fut in as_completed(futures):
                idx, res = fut.result()
                results[idx] = res
    except KeyboardInterrupt:
        print("\n  ⚠ interrupted — using partial results so far", flush=True)

    print(f"  → done in {time.monotonic() - t0:.1f}s total", flush=True)
    return results
