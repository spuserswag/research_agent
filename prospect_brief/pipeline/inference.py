"""Strategist inference layer.

Runs ONE LLM call over the verified-facts core to produce a clearly-labeled
inference section: revenue triangulation, market position, strategic
priorities, and tailored value hooks. Every inferred line cites the verified
facts it reasons from, and is tagged `[inferred · S1, S3]` so the reader
can tell at a glance which lines are verifiable vs synthesized.

The strategist NEVER touches the verified-facts core. It reads it. Its
output appears in a dedicated brief section that's visually demarcated.
"""

from __future__ import annotations
import json
import logging
import os
import re
from pathlib import Path
from typing import Iterable

from openai import OpenAI

from .schema import VerifiedFacts
from . import config
from . import cache as _cache

log = logging.getLogger(__name__)

PROMPT_PATH = Path(__file__).parent.parent / "prompts" / "strategist.md"
STRATEGIST_VERSION = "v5-2026-05-08-weak-risk-signals"


def _system_prompt() -> str:
    return PROMPT_PATH.read_text()


def _payload_for(facts: VerifiedFacts, industry_context: list[str],
                 id_map: dict[str, str]) -> dict:
    """Assemble the JSON payload the strategist sees. We pass display IDs
    (S1, S2, ...) so cited inferences match the brief's own numbering."""
    fact_rows = []
    for f in facts.facts:
        # Translate internal source IDs to display IDs.
        display_ids = [id_map.get(sid, sid) for sid in f.source_ids]
        fact_rows.append({
            "kind": f.fact_kind,
            "payload": f.payload,
            "source_ids": display_ids,
            "tier": f.tier.value,
            "stale": f.stale,
        })
    sources = [
        {"id": id_map.get(s.id, s.id), "type": s.type, "url": s.url,
         "publisher": s.publisher, "title": s.title}
        for s in facts.sources if id_map.get(s.id)
    ]
    return {
        "company": facts.company,
        "ticker": facts.ticker,
        "verified_facts": fact_rows,
        "sources": sources,
        "industry_context": industry_context or [],
    }


def _make_client() -> OpenAI:
    base_url = os.environ.get("OPENAI_BASE_URL")
    kwargs: dict = {"timeout": 60.0, "max_retries": 1}
    if base_url:
        kwargs["base_url"] = base_url
    return OpenAI(**kwargs)


def run_strategist(
    facts: VerifiedFacts,
    *,
    id_map: dict[str, str],
    industry_context: Iterable[str] = (),
    model: str | None = None,
    audience: str = "generic",
) -> str:
    """Return the strategist's markdown output, or "" on failure.

    On any error (no API key, network, model refusal, empty response), we
    silently return an empty string and the brief renderer omits the
    section. The verified-facts core is never affected.
    """
    if not facts.facts:
        return ""    # nothing to reason from

    chosen_model = model or os.environ.get(
        "STRATEGIST_MODEL", "gpt-4o"   # better synthesis than gpt-4o-mini
    )
    industry_context_list = list(industry_context)
    payload = _payload_for(facts, industry_context_list, id_map)
    payload["audience"] = audience

    # Cache on (company, fact_kinds_signature, prompt_version, model) so
    # re-runs with the same verified facts are free.
    fact_signature = ",".join(sorted(
        f"{r['kind']}:{r['payload'].get('attribute', '') or r['payload'].get('person', '')}"
        for r in payload["verified_facts"]
    ))
    cache_key = (
        f"{facts.company}|{fact_signature}|{audience}|{chosen_model}|{STRATEGIST_VERSION}"
    )
    if not _cache.reads_disabled():
        hit = _cache.cache_get("strategist", cache_key)
        if hit is not None:
            return hit

    try:
        client = _make_client()
        resp = client.chat.completions.create(
            model=chosen_model,
            messages=[
                {"role": "system", "content": _system_prompt()},
                {"role": "user",
                 "content": "Verified facts payload:\n\n"
                            + json.dumps(payload, ensure_ascii=False, indent=2)},
            ],
            max_tokens=2048,
        )
        out = (resp.choices[0].message.content or "").strip()
    except Exception as e:
        log.warning("strategist call failed: %s", e)
        return ""

    # Defense check: every bullet line should end with `[inferred · ...]`.
    # Strip any line that has `[confirmed]` or `[corroborated]` — those are
    # tier badges reserved for the verified-facts core. The model shouldn't
    # produce them, but if it does, drop those lines silently rather than
    # confusing the reader.
    cleaned: list[str] = []
    for line in out.splitlines():
        if re.search(r"\[(confirmed|corroborated|single_signal)\b", line):
            log.info("strategist: stripping line with tier badge: %r",
                     line[:80])
            continue
        cleaned.append(line)
    out = "\n".join(cleaned).strip()

    if out:
        try:
            _cache.cache_put("strategist", cache_key, out)
        except Exception:
            pass
    return out
