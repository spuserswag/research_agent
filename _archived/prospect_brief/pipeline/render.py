"""Render the final brief from VerifiedFacts.

Two paths:
  - `render_template(facts)` — deterministic markdown rendering with NO LLM
    in the loop. This is the safe default. Bullets are produced from the
    structured payload. Quotes are inserted verbatim. No paraphrasing.
  - `render_with_llm(facts)` — runs the writer prompt over the verified
    facts to produce slightly more natural prose. Only used if the caller
    explicitly opts in; the prompt forbids new claims and the output is
    re-run through the verifier (quotes re-checked) before publishing.

The default in `cli.py` is `render_template`. The LLM path exists for
teams who want it but isn't required to make the pipeline work.
"""

from __future__ import annotations
from collections import defaultdict
from datetime import date
from typing import Dict, List
from urllib.parse import urlparse

from .schema import VerifiedFacts, VerifiedFact, ConfidenceTier, Source
from . import config
from .verify import red_flag_eligible


def _renumber_for_strategist(vf: VerifiedFacts) -> Dict[str, str]:
    """Same renumbering as _renumber but exposed for the strategist call."""
    return _renumber(vf)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _src_lookup(facts: VerifiedFacts) -> Dict[str, Source]:
    return {s.id: s for s in facts.sources}


def _short_id(s: Source, idx: int) -> str:
    return f"S{idx + 1}"


def _renumber(facts: VerifiedFacts) -> Dict[str, str]:
    """Map original source IDs to display IDs (S1, S2, ...) in citation order."""
    used: List[str] = []
    seen = set()
    for f in facts.facts:
        for sid in f.source_ids:
            if sid not in seen:
                seen.add(sid)
                used.append(sid)
    return {sid: f"S{i+1}" for i, sid in enumerate(used)}


def _cite(f: VerifiedFact, id_map: Dict[str, str]) -> str:
    ids = ", ".join(id_map.get(sid, sid) for sid in f.source_ids)
    stale = " · stale" if f.stale else ""
    return f"[{f.tier.value} · {ids}{stale}]"


def _bullet(text: str, citation: str) -> str:
    return f"- {text} {citation}"


# ---------------------------------------------------------------------------
# Per-section renderers
# ---------------------------------------------------------------------------

def _facts_by_kind(facts: VerifiedFacts) -> Dict[str, List[VerifiedFact]]:
    out: Dict[str, List[VerifiedFact]] = defaultdict(list)
    for f in facts.facts:
        if f.tier == ConfidenceTier.inferred:
            continue
        out[f.fact_kind].append(f)
    return out


def _render_happening(by_kind, id_map) -> List[str]:
    lines = []
    # Only render leadership_changes that have a real effective_date AND a
    # change_type other than the LinkedIn-snippet default. Current-state
    # roster info already lives in the Leadership team section.
    for f in by_kind.get("leadership_changes", []):
        p = f.payload
        eff = p.get("effective_date")
        if not eff:
            continue   # current-state, not an event — skip in activity feed
        line = (f"{p['change_type'].capitalize()}: {p['person']} as {p['role']}, "
                f"effective {eff}.")
        lines.append(_bullet(line, _cite(f, id_map)))
        lines.append(f"  > \"{p['verbatim_quote']}\"")
    for f in by_kind.get("financial_signals", []):
        p = f.payload
        period = p.get("period") or ""
        mag = p.get("magnitude_text") or ""
        line = (f"{period} {p['metric']}: {mag} ({p['direction']}).").strip()
        lines.append(_bullet(line, _cite(f, id_map)))
        lines.append(f"  > \"{p['verbatim_quote']}\"")
    for f in by_kind.get("hiring_signals", []):
        p = f.payload
        roles = ", ".join(p.get("notable_titles", [])[:3])
        tech = ", ".join(p.get("tech_keywords", [])[:5])
        # `.get(key, default)` only returns default if key is MISSING — when the
        # value is explicitly None we still need to coalesce.
        role_count = p.get("role_count") or "?"
        window = p.get("window_days")
        window_str = f"in last {window} days" if window else "(window unspecified)"
        line = (f"{role_count} open {p['function']} roles {window_str}"
                + (f"; titles include {roles}" if roles else "")
                + (f"; tech: {tech}" if tech else "") + ".")
        lines.append(_bullet(line, _cite(f, id_map)))
        if p.get("verbatim_quote"):
            lines.append(f"  > \"{p['verbatim_quote']}\"")
    for f in by_kind.get("product_launches", []):
        p = f.payload
        lines.append(_bullet(
            f"Product launch: {p['product_name']}"
            + (f" ({p['launch_date']})" if p.get("launch_date") else "") + ".",
            _cite(f, id_map),
        ))
        lines.append(f"  > \"{p['verbatim_quote']}\"")
    for f in by_kind.get("customer_or_partnership", []):
        p = f.payload
        lines.append(_bullet(
            f"{p['type'].replace('_', ' ').title()}: {p['counterparty']}"
            + (f" ({p['announced_date']})" if p.get("announced_date") else "") + ".",
            _cite(f, id_map),
        ))
        lines.append(f"  > \"{p['verbatim_quote']}\"")
    for f in by_kind.get("funding_events", []):
        p = f.payload
        amt = p.get("amount_usd_text") or "amount unspecified"
        lines.append(_bullet(
            f"{p['event_type'].title()}: {amt}"
            + (f" on {p['event_date']}" if p.get("event_date") else "") + ".",
            _cite(f, id_map),
        ))
        lines.append(f"  > \"{p['verbatim_quote']}\"")
    return lines


def _render_priorities(by_kind, id_map) -> List[str]:
    lines = []
    for f in by_kind.get("exec_statements", []):
        p = f.payload
        topics = ", ".join(p.get("topic_tags", [])[:4])
        speaker = f"{p['speaker_name']} ({p['speaker_title']})"
        line = (f"{speaker}, {p['forum'].replace('_', ' ')}, "
                f"{p.get('statement_date', 'date unspecified')}: "
                + (f"topics — {topics}" if topics else "stated:"))
        lines.append(_bullet(line, _cite(f, id_map)))
        lines.append(f"  > \"{p['verbatim_quote']}\"")
    return lines


def _render_red_flags(by_kind, id_map, sources_by_id) -> List[str]:
    lines: List[str] = []
    candidates: List[VerifiedFact] = []

    for f in by_kind.get("litigation_or_regulatory", []):
        if any(red_flag_eligible(sources_by_id[sid]) for sid in f.source_ids):
            candidates.append(f)
    for f in by_kind.get("financial_signals", []):
        m = f.payload.get("metric", "")
        d = f.payload.get("direction", "")
        if m in {"layoffs", "restructuring"} or (m == "guidance" and d == "down") \
           or (m == "revenue" and d == "down"):
            if any(red_flag_eligible(sources_by_id[sid]) for sid in f.source_ids):
                candidates.append(f)
    for f in by_kind.get("leadership_changes", []):
        if f.payload.get("change_type") == "departed":
            if any(red_flag_eligible(sources_by_id[sid]) for sid in f.source_ids):
                candidates.append(f)

    if not candidates:
        return ["- No public red flags identified meeting the source-allowlist bar."]

    for f in candidates:
        p = f.payload
        if f.fact_kind == "litigation_or_regulatory":
            line = (f"{p['matter_short_name']} filed {p.get('filed_date', '?')} "
                    f"in {p['forum']}"
                    + (f" ({p.get('docket_or_case_number')})" if p.get("docket_or_case_number") else "")
                    + (f" — status: {p['status']}" if p.get("status") else "") + ".")
        elif f.fact_kind == "financial_signals":
            line = (f"{p['metric'].replace('_', ' ').title()}: "
                    f"{p.get('magnitude_text', '')} "
                    f"({p['direction']}, {p.get('period', '')}).")
        elif f.fact_kind == "leadership_changes":
            line = (f"Departure: {p['person']} ({p['role']}), "
                    f"effective {p.get('effective_date', 'unspecified')}.")
        else:
            line = str(p)
        lines.append(_bullet(line, _cite(f, id_map)))
        lines.append(f"  > \"{p['verbatim_quote']}\"")
    return lines


def _render_icebreakers(by_kind, id_map) -> List[str]:
    """Surface 1-3 anchored, low-risk conversation starters drawn from
    leadership changes, recent product launches, and customer wins."""
    picks = []
    for kind in ("leadership_changes", "product_launches", "customer_or_partnership"):
        if by_kind.get(kind):
            picks.append(by_kind[kind][0])
        if len(picks) >= 3:
            break
    if not picks:
        return ["- (No recent named events surfaced — let the prospect set the agenda.)"]
    out = []
    for f in picks:
        p = f.payload
        if f.fact_kind == "leadership_changes":
            eff = p.get("effective_date") or "recent"
            change_phrase = {
                "hired": "joined as",
                "departed": "stepped down from",
                "promoted": "was promoted to",
                "reassigned": "moved into",
            }.get(p.get("change_type", ""), "took the role of")
            opener = (f"{p['person']} {change_phrase} {p['role']} "
                      f"({eff}). Worth acknowledging directly.")
        elif f.fact_kind == "product_launches":
            opener = (f"They've recently launched {p['product_name']} — "
                      "expect this to feature in their narrative.")
        else:
            ctype = (p.get("type") or "").replace("_", " ")
            opener = (f"They publicly announced a {ctype} with "
                      f"{p['counterparty']} — fair to bring up.")
        out.append(_bullet(opener, _cite(f, id_map)))
        out.append(f"  > \"{p['verbatim_quote']}\"")
    return out


def _render_value_hooks(by_kind, id_map) -> List[str]:
    """One paragraph max. Only render when there's a substantive anchor:
    a financial signal with magnitude, OR an exec statement with topic tags.
    Otherwise omit the section rather than emit a generic paragraph."""
    fin = by_kind.get("financial_signals", [])
    exec_st = by_kind.get("exec_statements", [])

    fin_anchors = [f for f in fin if f.payload.get("magnitude_text")]
    exec_anchors = [f for f in exec_st if f.payload.get("topic_tags")]
    anchors: List[VerifiedFact] = fin_anchors + exec_anchors

    if not anchors:
        return []

    bits: List[str] = []
    if fin_anchors:
        magnitudes = [f.payload.get("magnitude_text", "") for f in fin_anchors[:2]]
        bits.append(
            "Quantified posture (" + "; ".join(m for m in magnitudes if m) + ") "
            "constrains positioning — lead with ROI and named pain points, not "
            "a transformation narrative."
        )
    if exec_anchors:
        topics: List[str] = []
        for f in exec_anchors[:2]:
            topics.extend(f.payload.get("topic_tags", [])[:2])
        topics = list(dict.fromkeys(topics))[:4]
        if topics:
            bits.append(
                "Their own stated topics — " + ", ".join(topics) + " — are the "
                "natural starting point. Reference these in your pitch using "
                "their words."
            )

    sids: List[str] = []
    seen = set()
    for f in anchors[:5]:
        for sid in f.source_ids:
            if sid not in seen:
                seen.add(sid)
                sids.append(sid)
    citation = "[" + ", ".join(id_map.get(s, s) for s in sids) + "]"
    return [" ".join(bits) + " " + citation]


_PROFILE_LABEL = {
    "founded_year": "Founded",
    "headquarters": "HQ",
    "office_locations": "Offices",
    "primary_markets": "Primary markets",
    "services_offered": "Services",
    "specialties": "Specialties",
    "industry_certifications": "Certifications",
    "employee_count_range": "Headcount range",
    "annual_revenue_range": "Revenue range",
    "ownership_structure": "Ownership",
    "mission_statement": "Mission",
    "stated_values": "Stated values",
    "notable_clients": "Notable clients",
    "awards_recognition": "Awards / recognition",
    "community_involvement": "Community involvement",
    "cage_code": "CAGE code",
    "uei": "UEI",
    "naics_codes": "NAICS",
    "technology_stack": "Tech stack",
    "operational_throughput": "Operational throughput",
}


def _profile_by_attr(by_kind):
    out: dict[str, list[VerifiedFact]] = {}
    for f in by_kind.get("company_profile", []):
        out.setdefault(f.payload.get("attribute", ""), []).append(f)
    return out


def _render_attr_block(by_attr, attrs: list[str], id_map) -> List[str]:
    """Render a subset of company_profile attributes as labeled bullets."""
    lines: List[str] = []
    tier_rank = {"confirmed": 0, "corroborated": 1, "single_signal": 2, "inferred": 3}
    for attr in attrs:
        if attr not in by_attr:
            continue
        facts_here = sorted(by_attr[attr], key=lambda f: tier_rank[f.tier.value])
        f = facts_here[0]
        v = f.payload.get("value", "")
        label = _PROFILE_LABEL.get(attr, attr)
        lines.append(_bullet(f"**{label}:** {v}", _cite(f, id_map)))
        if f.payload.get("verbatim_quote"):
            lines.append(f"  > \"{f.payload['verbatim_quote']}\"")
    return lines


def _render_snapshot(by_kind, id_map) -> List[str]:
    """Identity & scale only — keep this section tight so leadership can read
    it in 5 seconds. Mission/values/clients/awards get their own sections."""
    by_attr = _profile_by_attr(by_kind)
    return _render_attr_block(by_attr, [
        "founded_year", "headquarters", "office_locations",
        "primary_markets", "services_offered", "specialties",
        "industry_certifications", "employee_count_range",
        "annual_revenue_range", "ownership_structure",
    ], id_map)


def _render_mission_values(by_kind, id_map) -> List[str]:
    by_attr = _profile_by_attr(by_kind)
    return _render_attr_block(by_attr, [
        "mission_statement", "stated_values", "community_involvement",
    ], id_map)


def _render_clients_awards(by_kind, id_map) -> List[str]:
    by_attr = _profile_by_attr(by_kind)
    return _render_attr_block(by_attr, [
        "notable_clients", "awards_recognition",
    ], id_map)


def _render_federal_ids(by_kind, id_map) -> List[str]:
    by_attr = _profile_by_attr(by_kind)
    return _render_attr_block(by_attr, [
        "cage_code", "uei", "naics_codes",
    ], id_map)


def _render_tech_throughput(by_kind, id_map) -> List[str]:
    by_attr = _profile_by_attr(by_kind)
    return _render_attr_block(by_attr, [
        "technology_stack", "operational_throughput",
    ], id_map)


def _coverage_assessment(facts) -> tuple[str, str]:
    """Return (label, advisory). label ∈ {"rich", "moderate", "thin"}."""
    n_facts = len(facts.facts)
    has_filings = any(s.type in {"10-K", "10-Q", "8-K"} for s in facts.sources)
    has_earnings = any(s.type == "earnings_call_transcript" for s in facts.sources)
    has_exec_quotes = any(f.fact_kind == "exec_statements" for f in facts.facts)

    if has_filings and has_earnings and n_facts >= 8:
        return ("rich",
                "Strong public-filing coverage. You have enough quoted "
                "specifics to lead the conversation with their own language.")
    if (has_filings or has_exec_quotes) and n_facts >= 4:
        return ("moderate",
                "Mixed coverage. Anchor on the verified facts below; some "
                "context will need to come from the conversation itself.")
    return ("thin",
            "Thin public coverage — typical for a private regional company. "
            "What's below is what's verifiable; treat the open questions at "
            "the bottom as the spine of the conversation rather than an "
            "afterthought.")


def _confidence_warning(facts) -> str:
    """Return a prominent warning string when the brief is fact-poor.

    Coverage label tells the AE what kind of prospect this is. This warning
    tells them how much they should trust the brief itself. The two are
    related but distinct — a thin-coverage prospect with 30 verified facts
    is more trustworthy than a moderate-coverage prospect with 4.
    """
    n_total = len(facts.facts)
    n_high = sum(1 for f in facts.facts if f.tier.value in ("confirmed", "corroborated"))
    if n_total < 5:
        return (f"⚠️ **LOW-CONFIDENCE BRIEF**: only {n_total} verified fact"
                f"{'s' if n_total != 1 else ''} surfaced. "
                "Treat everything below — including the strategist's "
                "inferences — as exploratory. Discovery questions are the "
                "main deliverable.")
    if n_high < 2:
        return (f"⚠️ **LIMITED CONFIDENCE**: {n_total} facts but only "
                f"{n_high} reach confirmed/corroborated tier — the rest are "
                "single-source. The brief is useful as a primer, but "
                "corroborate key claims in the meeting before relying on them.")
    return ""


# ---------------------------------------------------------------------------
# Audience-aware discovery question banks. Each persona gets a different
# default question set so a CTO meeting doesn't open with CFO-flavored
# revenue-trajectory questions.
# ---------------------------------------------------------------------------

_QUESTIONS_BY_AUDIENCE: dict[str, list[str]] = {
    "ceo": [
        "How is the business performing this year vs last? "
        "(Revenue trajectory, margin pressure, capex plans.)",
        "What are the top 2-3 priorities leadership has named for the next "
        "12 months? Listen for their language.",
        "Who are their largest 2-3 customers, and what's the renewal / "
        "expansion picture there?",
        "What's the hardest decision the team is sitting on right now?",
    ],
    "cfo": [
        "Revenue trajectory and margin profile vs last year — and any "
        "near-term pressures on either?",
        "How is capex allocated across infrastructure, headcount, and "
        "tooling? Where would they spend more if they had it?",
        "Customer concentration — what % of revenue is the top 5?",
        "Working-capital posture: are receivables / collections an issue?",
    ],
    "cto": [
        "What's the current technology stack and which pieces of it are "
        "they actively trying to replace or upgrade?",
        "Where is engineering capacity most constrained right now? Build vs "
        "buy decisions on the table?",
        "How do they handle the data-gravity / processing-tax problem at "
        "their current operational scale?",
        "What integration / interoperability headaches are eating cycles? "
        "(Standards mismatches, vendor lock-in, custom glue.)",
        "Security & compliance posture — anything regulatory shaping the "
        "12-month roadmap (CMMC, SOC2, HIPAA, FedRAMP)?",
    ],
    "coo": [
        "Throughput and capacity — what's the gating constraint right now? "
        "Headcount, tools, suppliers, or process?",
        "Where in the operational workflow are they spending the most "
        "person-hours that should be automated?",
        "What's their peak-vs-trough demand variance look like, and how "
        "do they staff/equip for it?",
        "Quality / rework rate — any pattern of where errors cluster?",
    ],
    "cro": [
        "Pipeline health — coverage ratio vs target, average sales cycle, "
        "win rate by segment?",
        "Largest deal in pipeline right now and what's standing in its way?",
        "Where are they over-indexed on a single channel or rep, and what "
        "would diversifying require?",
        "Customer expansion — what % of revenue is from existing accounts?",
    ],
    "generic": [
        "How is the business performing this year vs last? "
        "(Revenue trajectory, margin pressure, capex plans.)",
        "What are the top 2-3 priorities leadership has named for the next "
        "12 months? Listen for their language.",
        "Where are they investing in headcount, and where are they "
        "constrained?",
        "Who are their largest 2-3 customers, and what's the renewal / "
        "expansion picture there?",
        "What new services have they added in the last 12 months that "
        "they're trying to grow?",
    ],
}


def _discovery_questions_for_thin(by_kind, audience: str = "generic") -> List[str]:
    """For thin-coverage prospects, surface concrete discovery questions.
    The audience parameter picks a persona-tailored question bank."""
    bank = _QUESTIONS_BY_AUDIENCE.get(audience.lower(),
                                      _QUESTIONS_BY_AUDIENCE["generic"])
    return bank[:5]


def _render_known_people(by_kind, id_map, *, company_name: str = "") -> List[str]:
    """Surface leadership_changes facts as a flat 'Known people / contacts'
    list. This catches LinkedIn-derived names that wouldn't fit Icebreakers
    (no recent change_type, no fresh effective_date) but are useful to know.
    Dedupes by person name. Drops facts where:
      - role is empty / "N/A" / "NA" / equal to the company name (the model
        sometimes echoes the company name into the role field when the LinkedIn
        snippet is sparse)
      - person field equals the company name (company-name-as-person extraction
        garbage)
    """
    leaders = by_kind.get("leadership_changes", [])
    if not leaders:
        return []
    seen: set = set()
    lines: List[str] = []
    company_lower = company_name.lower()
    for f in leaders:
        p = f.payload
        person = (p.get("person") or "").strip()
        if not person or person.lower() in seen:
            continue
        # Reject company-name-as-person.
        if company_lower and (
            person.lower() == company_lower
            or "construction company" in person.lower()
            or "llc" in person.lower()
        ):
            continue

        role = (p.get("role") or "").strip()
        # Reject empty / "N/A" / company-name-as-role.
        if not role or role.upper() in {"N/A", "NA", "NONE"}:
            continue
        if company_lower and role.lower() == company_lower:
            continue
        if "construction company" in role.lower() and len(role) < 40:
            # e.g. role accidentally set to "Brantley Construction Company"
            continue

        seen.add(person.lower())
        lines.append(_bullet(
            f"**{person}** — {role}",
            _cite(f, id_map),
        ))
        q = p.get("verbatim_quote", "")
        if q:
            lines.append(f"  > \"{q}\"")
    return lines


def _render_other_exec_quotes(by_kind, id_map) -> List[str]:
    """In thin mode the strategic-priorities section is replaced with discovery
    questions, but we still want to show any verified exec quotes if we have
    them (otherwise they're invisible despite passing all gates)."""
    statements = by_kind.get("exec_statements", [])
    if not statements:
        return []
    lines: List[str] = []
    for f in statements[:5]:
        p = f.payload
        speaker = f"{p.get('speaker_name', '?')} ({p.get('speaker_title', '?')})"
        date_str = p.get("statement_date") or ""
        line = f"{speaker}" + (f" — {date_str}" if date_str else "")
        lines.append(_bullet(line, _cite(f, id_map)))
        lines.append(f"  > \"{p['verbatim_quote']}\"")
    return lines


# ---------------------------------------------------------------------------
# Top-level
# ---------------------------------------------------------------------------

def render_template(vf: VerifiedFacts, *, strategist_md: str = "",
                    audience: str = "generic") -> str:
    by_kind = _facts_by_kind(vf)
    id_map = _renumber(vf)
    sources_by_id = _src_lookup(vf)

    n_conf = sum(1 for f in vf.facts if f.tier == ConfidenceTier.confirmed)
    n_corr = sum(1 for f in vf.facts if f.tier == ConfidenceTier.corroborated)
    n_sing = sum(1 for f in vf.facts if f.tier == ConfidenceTier.single_signal)

    coverage_label, coverage_advisory = _coverage_assessment(vf)
    confidence_warning = _confidence_warning(vf)

    parts: List[str] = []
    parts.append(f"# Pre-Discovery Brief — {vf.company}"
                 + (f" ({vf.ticker})" if vf.ticker else ""))
    parts.append(
        f"For: {vf.ae} · Meeting: {vf.meeting_date.isoformat()} · "
        f"Generated: {vf.generated_at.date().isoformat()} · "
        f"Confidence: {n_conf} confirmed / {n_corr} corroborated / "
        f"{n_sing} single-signal"
    )
    parts.append(
        f"Coverage: {vf.coverage_window_start.isoformat()} → "
        f"{vf.coverage_window_end.isoformat()} · "
        f"Signal quality: **{coverage_label}**"
    )
    parts.append("")
    if confidence_warning:
        parts.append(f"> {confidence_warning}")
        parts.append("")
    parts.append(f"_{coverage_advisory}_")
    parts.append("")

    # ── Identity & scale ──────────────────────────────────────────────────
    snapshot = _render_snapshot(by_kind, id_map)
    if snapshot:
        parts.append("## Snapshot")
        parts.append("")
        parts.extend(snapshot)
        parts.append("")

    # ── Leadership team (always renders if we have any) ───────────────────
    people = _render_known_people(by_kind, id_map, company_name=vf.company)
    if people:
        parts.append("## Leadership team")
        parts.append("")
        parts.extend(people)
        parts.append("")

    # ── Mission & values (culture signals from About page) ────────────────
    mission_block = _render_mission_values(by_kind, id_map)
    if mission_block:
        parts.append("## Mission & values")
        parts.append("")
        parts.extend(mission_block)
        parts.append("")

    # ── Notable clients & awards ──────────────────────────────────────────
    proof_block = _render_clients_awards(by_kind, id_map)
    if proof_block:
        parts.append("## Notable clients & recognition")
        parts.append("")
        parts.extend(proof_block)
        parts.append("")

    # ── Federal-contractor identifiers ────────────────────────────────────
    fed_ids = _render_federal_ids(by_kind, id_map)
    if fed_ids:
        parts.append("## Federal contractor IDs")
        parts.append("")
        parts.extend(fed_ids)
        parts.append("")

    # ── Tech stack & operational scale ────────────────────────────────────
    tech_block = _render_tech_throughput(by_kind, id_map)
    if tech_block:
        parts.append("## Tech stack & operational scale")
        parts.append("")
        parts.extend(tech_block)
        parts.append("")

    # ── Stated priorities (quoted exec statements) ────────────────────────
    priorities = _render_priorities(by_kind, id_map)
    if priorities:
        parts.append("## Stated priorities (their words)")
        parts.append("")
        parts.extend(priorities)
        parts.append("")
    elif coverage_label == "thin":
        other_quotes = _render_other_exec_quotes(by_kind, id_map)
        if other_quotes:
            parts.append("## Other verified quotes")
            parts.append("")
            parts.extend(other_quotes)
            parts.append("")

    # ── Recent activity (events with dates: hires, launches, financials) ──
    happening = _render_happening(by_kind, id_map)
    if happening:
        parts.append("## Recent verified activity")
        parts.append("")
        parts.extend(happening)
        parts.append("")

    # ── Strategist inference (opt-in; clearly labeled as inference) ───────
    if strategist_md:
        parts.append("---")
        parts.append("")
        parts.append("## Strategic context (inferred)")
        parts.append("")
        parts.append("_The lines below are **inferred** from the verified facts above, "
                     "not directly extracted quotes. Each line cites the verified "
                     "source(s) it reasons from. Read this section as informed "
                     "synthesis — useful for prep, not safe to quote verbatim in "
                     "the meeting._")
        parts.append("")
        parts.append(strategist_md)
        parts.append("")
        parts.append("---")
        parts.append("")

    # ── Recent context worth referencing in conversation ──────────────────
    parts.append("## Recent context worth referencing")
    parts.append("")
    parts.extend(_render_icebreakers(by_kind, id_map))
    parts.append("")

    # ── Discovery questions (when coverage is thin) ───────────────────────
    if coverage_label == "thin":
        parts.append(f"## Open questions for the conversation"
                     + (f" ({audience.upper()} flavor)"
                        if audience and audience != "generic" else ""))
        parts.append("")
        parts.extend(f"- {q}"
                     for q in _discovery_questions_for_thin(by_kind, audience))
        parts.append("")

    parts.append("## Potential red flags")
    parts.append("")
    parts.extend(_render_red_flags(by_kind, id_map, sources_by_id))
    parts.append("")

    hooks = _render_value_hooks(by_kind, id_map)
    if hooks:
        parts.append("## Value alignment hooks")
        parts.append("")
        parts.extend(hooks)
        parts.append("")

    parts.append("## What we couldn't find")
    parts.append("")
    if vf.gaps:
        parts.extend(f"- {g}" for g in vf.gaps)
    else:
        parts.append("- (no gaps logged)")
    parts.append("")

    parts.append("## Sources")
    parts.append("")
    for orig_id, display_id in id_map.items():
        s = sources_by_id[orig_id]
        date_str = s.publish_date.isoformat() if s.publish_date else "date unknown"
        parts.append(f"{display_id} — {s.publisher}, {date_str}, {s.url}")
    parts.append("")

    # Break down strip reasons so "N stripped" isn't ambiguous.
    # Collapse the verbose value_not_supported_by_quote variants into a single
    # bucket so the footer stays readable.
    def _short_reason(r: str) -> str:
        if r.startswith("value_not_supported_by_quote"):
            return "value not supported by quote"
        return {
            "quote_not_in_source": "hallucinated quote",
            "source_out_of_coverage_window": "source out of window",
            "fact_date_out_of_window": "fact date out of window",
        }.get(r, r)

    strip_reasons: dict[str, int] = {}
    for s in vf.verifier_log.stripped:
        key = _short_reason(s.get("reason", "unknown"))
        strip_reasons[key] = strip_reasons.get(key, 0) + 1
    reason_strs = [f"{n} {r}" for r, n in strip_reasons.items()]
    breakdown = (" — " + ", ".join(reason_strs)) if reason_strs else ""

    parts.append(
        f"_Verifier: {vf.verifier_log.quotes_passed}/"
        f"{vf.verifier_log.quotes_checked} quotes verified. "
        f"{len(vf.verifier_log.stripped)} stripped pre-publish{breakdown}._"
    )
    return "\n".join(parts)
