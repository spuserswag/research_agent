"""End-to-end demo: run the pipeline against real Asana sources.

We simulate the extractor stage by hand-coding the SourceExtraction objects
(this is what the LLM extractor would return). Every verbatim_quote here is
copied from the snippet text below. The verifier then substring-checks each
quote against the source text — including a couple of intentionally-wrong
quotes near the bottom that we expect to be stripped.

Run:
    cd prospect_brief
    python examples/run_asan_demo.py

Output written to examples/ASAN/.
"""
from __future__ import annotations
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from datetime import date, datetime, timezone

from pipeline.schema import (
    Source, SourceExtraction,
    LeadershipChange, FinancialSignal, ExecStatement,
    HiringSignal, ProductLaunch, CustomerOrPartnership,
    LitigationOrRegulatory, FundingEvent,
)
from pipeline import verify as V
from pipeline import render as R


# ---------------------------------------------------------------------------
# Real sources, gathered via web search on 2026-05-07.
# `text` is the snippet content returned by the search API.
# ---------------------------------------------------------------------------

ACCESSED = datetime(2026, 5, 7, 14, 22, tzinfo=timezone.utc)


SOURCES = [
    Source(
        id="ASAN-PR-FY26Q4",
        type="press_release",
        url=("https://investors.asana.com/news-releases/news-release-details/"
             "asana-announces-fourth-quarter-and-fiscal-year-2026-results"),
        publisher="investors.asana.com",
        publish_date=date(2026, 3, 2),
        title="Asana Announces Fourth Quarter and Fiscal Year 2026 Results",
        accessed_at=ACCESSED,
        text=(
            "Asana reported financial results for its fourth quarter and "
            "fiscal year ended January 31, 2026, which were announced on "
            "March 2, 2026. Q4 revenue was $205.6 million, up 9% year over "
            "year. Additionally, the company expanded Q4 GAAP operating "
            "margin by over 17 percentage points and non-GAAP operating "
            "margin by 10 percentage points. Operating cash flow grew by "
            "74% and adjusted free cash flow by 108% year over year. "
            "The number of Core customers (spending $5,000 or more "
            "annually) grew to 25,928, an increase of 8% year over year, "
            "with revenues from Core customers growing 10% year over year. "
            "The number of customers spending $100,000 or more annually "
            "grew to 817, an increase of 13% year over year. "
            "Overall dollar-based net retention rate in Q4 was 96%. "
            "Dan Rogers, Chief Executive Officer of Asana, stated: \"FY26 "
            "was a year of meaningful progress as we advanced Asana into a "
            "multi-product platform and strengthened our position as the "
            "foundational system of action layer for the Agentic Enterprise\"."
        ),
    ),
    Source(
        id="ASAN-8K-CEO",
        type="8-K",
        url=("https://investors.asana.com/static-files/"
             "541d03df-30f1-4447-ac4b-a8d92514d620"),
        publisher="investors.asana.com",
        publish_date=date(2025, 6, 25),
        title="Form 8-K — Asana CEO Succession",
        accessed_at=ACCESSED,
        text=(
            "On June 25, 2025 the Board of Directors of Asana, Inc. "
            "announced the planned appointment of Mr. Daniel Rogers as the "
            "Company's Chief Executive Officer and a member of the Board, "
            "both effective July 21, 2025. Mr. Dustin Moskovitz, the "
            "current President and Chief Executive Officer of the Company, "
            "will retire from his position as President and Chief Executive "
            "Officer in connection with the appointment of Mr. Rogers as "
            "the Chief Executive Officer of the Company, effective July "
            "21, 2025. Mr. Moskovitz will transition on such date to a "
            "non-employee director and continue to serve on the Board as "
            "a Class I director and Chair of the Board."
        ),
    ),
    Source(
        id="ASAN-CNBC-CEO",
        type="news_article",
        url=("https://www.cnbc.com/2025/06/25/"
             "asana-ceo-dan-rogers-replace-dustin-moskovitz.html"),
        publisher="cnbc.com",
        publish_date=date(2025, 6, 25),
        title=("Asana picks Dan Rogers, formerly of ServiceNow, "
               "to replace CEO Dustin Moskovitz"),
        accessed_at=ACCESSED,
        byline="CNBC Staff",
        text=(
            "Asana's new CEO, Dan Rogers, comes from software startup "
            "LaunchDarkly, where he was CEO. Rogers was previously "
            "president of Rubrik and marketing chief at ServiceNow and "
            "Symantec. Asana picks Dan Rogers, formerly of ServiceNow, "
            "to replace CEO Dustin Moskovitz."
        ),
    ),
    Source(
        id="ASAN-PR-FY25Q4",
        type="press_release",
        url=("https://investors.asana.com/news-releases/news-release-details/"
             "asana-announces-fourth-quarter-and-fiscal-year-2025-results"),
        publisher="investors.asana.com",
        publish_date=date(2025, 3, 11),
        title="Asana Announces Fourth Quarter and Fiscal Year 2025 Results",
        accessed_at=ACCESSED,
        text=(
            "Q4 GAAP operating margin improved 590 basis points year over "
            "year; Q4 Non-GAAP operating margin improved 820 basis points "
            "year over year. The company achieved a significant milestone "
            "by reaching positive free cash flow for the full fiscal year "
            "2025. Customers spending $100,000 or more on an annualized "
            "basis grew to 726, an increase of 20% year over year. Overall "
            "dollar-based net retention rate in Q4 was 96%. The early "
            "momentum with AI Studio has exceeded expectations, with "
            "initial proof points confirming its transformative potential, "
            "including strong early customer adoption across segments and "
            "geographies, rapidly growing credit usage and a multi-million "
            "dollar pipeline."
        ),
    ),
    Source(
        id="ASAN-COMPUTERWORLD-LAYOFFS",
        type="news_article",
        url=("https://www.computerworld.com/article/1614969/"
             "asana-to-lay-off-9-of-its-workforce-to-improve-operating-costs.html"),
        publisher="computerworld.com",
        publish_date=date(2025, 2, 6),
        title="Asana to lay off 9% of its workforce to improve operating costs",
        accessed_at=ACCESSED,
        byline="Computerworld Staff",
        text=(
            "Asana announced a difficult decision to reduce its force, "
            "impacting about 9% of the global team, as part of a "
            "restructuring plan intended to improve operational "
            "efficiencies and operating costs and better align Asana's "
            "workforce with current business needs."
        ),
    ),
    Source(
        id="ASAN-WARN-FEB25",
        type="regulatory_filing",
        url="https://www.warntracker.com/company/asana",
        publisher="warntracker.com",
        publish_date=date(2025, 2, 6),
        title="Asana — WARN notices Nov 2022 to Feb 2025",
        accessed_at=ACCESSED,
        text=(
            "Asana, Inc. laid off 77 employees in San Francisco, CA on "
            "February 6, 2025. An additional 77 affected employees were "
            "announced on February 4, 2025. Asana has filed 4 WARN Act "
            "notices affecting a total of 271 workers, with the most "
            "recent filing on February 4, 2025."
        ),
    ),
    Source(
        id="ASAN-AISTUDIO-HELP",
        type="company_blog",
        url="https://help.asana.com/s/article/ai-studio-pricing?language=en_US",
        publisher="help.asana.com",
        publish_date=date(2025, 11, 1),
        title="AI Studio add-on and pricing",
        accessed_at=ACCESSED,
        text=(
            "AI Studio is available on Starter, Advanced, Enterprise, and "
            "Enterprise+ plans in three options: AI Studio Basic (included "
            "with rate limits), AI Studio Plus (paid add-on for individuals "
            "and small teams), and AI Studio Pro (paid add-on for scaling "
            "complex workflows with advanced billing controls on annual plans). "
            "The Starter tier includes AI Studio with 50,000 monthly credits "
            "as a notable feature offering entry-level AI capabilities."
        ),
    ),
]


# ---------------------------------------------------------------------------
# Hand-coded extractions — what the LLM extractor would return per source.
# Every verbatim_quote is copied from the source text above, ≤ 15 words.
# ---------------------------------------------------------------------------

EXTRACTIONS = [
    # ---- Q4 FY26 press release ----
    SourceExtraction(
        source_id="ASAN-PR-FY26Q4",
        financial_signals=[
            FinancialSignal(
                source_id="ASAN-PR-FY26Q4",
                verbatim_quote="Q4 revenue was $205.6 million, up 9% year over year",
                metric="revenue", direction="up",
                magnitude_text="$205.6M, +9% YoY", period="Q4 FY26",
                as_of_date=date(2026, 3, 2),
            ),
            FinancialSignal(
                source_id="ASAN-PR-FY26Q4",
                verbatim_quote=(
                    "expanded Q4 GAAP operating margin by over 17 percentage points"
                ),
                metric="operating_margin", direction="up",
                magnitude_text="+17pp YoY GAAP", period="Q4 FY26",
                as_of_date=date(2026, 3, 2),
            ),
            FinancialSignal(
                source_id="ASAN-PR-FY26Q4",
                verbatim_quote=(
                    "adjusted free cash flow by 108% year over year"
                ),
                metric="free_cash_flow", direction="up",
                magnitude_text="+108% YoY adj FCF", period="FY26",
                as_of_date=date(2026, 3, 2),
            ),
            FinancialSignal(
                source_id="ASAN-PR-FY26Q4",
                verbatim_quote="dollar-based net retention rate in Q4 was 96%",
                metric="guidance", direction="flat",
                magnitude_text="DBNR 96%", period="Q4 FY26",
                as_of_date=date(2026, 3, 2),
            ),
        ],
        exec_statements=[
            ExecStatement(
                source_id="ASAN-PR-FY26Q4",
                verbatim_quote=(
                    "the foundational system of action layer for the Agentic Enterprise"
                ),
                speaker_name="Dan Rogers", speaker_title="CEO",
                forum="press_release",
                statement_date=date(2026, 3, 2),
                topic_tags=["agentic-enterprise", "platform-strategy"],
            ),
            ExecStatement(
                source_id="ASAN-PR-FY26Q4",
                verbatim_quote=(
                    "advanced Asana into a multi-product platform"
                ),
                speaker_name="Dan Rogers", speaker_title="CEO",
                forum="press_release",
                statement_date=date(2026, 3, 2),
                topic_tags=["multi-product", "platform"],
            ),
        ],
        customer_or_partnership=[
            CustomerOrPartnership(
                source_id="ASAN-PR-FY26Q4",
                verbatim_quote=(
                    "customers spending $100,000 or more annually grew to 817"
                ),
                counterparty="$100k+ ARR cohort",
                type="customer_win",
                announced_date=date(2026, 3, 2),
            ),
        ],
    ),

    # ---- 8-K CEO succession ----
    SourceExtraction(
        source_id="ASAN-8K-CEO",
        leadership_changes=[
            LeadershipChange(
                source_id="ASAN-8K-CEO",
                verbatim_quote=(
                    "Mr. Daniel Rogers as the Company's Chief Executive Officer"
                ),
                person="Daniel Rogers",
                role="Chief Executive Officer",
                change_type="hired",
                effective_date=date(2025, 7, 21),
            ),
            LeadershipChange(
                source_id="ASAN-8K-CEO",
                verbatim_quote=(
                    "Mr. Dustin Moskovitz, the current President and Chief Executive"
                ),
                person="Dustin Moskovitz",
                role="Chief Executive Officer (outgoing) → Chair / non-employee director",
                change_type="reassigned",
                effective_date=date(2025, 7, 21),
            ),
        ],
    ),

    # ---- CNBC corroboration on CEO change ----
    SourceExtraction(
        source_id="ASAN-CNBC-CEO",
        leadership_changes=[
            LeadershipChange(
                source_id="ASAN-CNBC-CEO",
                verbatim_quote=(
                    "Asana picks Dan Rogers, formerly of ServiceNow, to replace CEO"
                ),
                person="Daniel Rogers",
                role="Chief Executive Officer",
                change_type="hired",
                effective_date=date(2025, 7, 21),
            ),
        ],
    ),

    # ---- FY25 Q4 press release (AI Studio first signal) ----
    SourceExtraction(
        source_id="ASAN-PR-FY25Q4",
        product_launches=[
            ProductLaunch(
                source_id="ASAN-PR-FY25Q4",
                verbatim_quote="The early momentum with AI Studio has exceeded expectations",
                product_name="AI Studio",
                launch_date=date(2024, 10, 1),  # AI Studio GA was earlier; we don't claim a precise GA date
                stated_purpose_quote="The early momentum with AI Studio has exceeded expectations",
            ),
        ],
        financial_signals=[
            FinancialSignal(
                source_id="ASAN-PR-FY25Q4",
                verbatim_quote=(
                    "reaching positive free cash flow for the full fiscal year 2025"
                ),
                metric="free_cash_flow", direction="up",
                magnitude_text="positive FCF FY25", period="FY25",
                as_of_date=date(2025, 3, 11),
            ),
        ],
    ),

    # ---- Computerworld layoffs (named-byline, eligible for red flags) ----
    SourceExtraction(
        source_id="ASAN-COMPUTERWORLD-LAYOFFS",
        financial_signals=[
            FinancialSignal(
                source_id="ASAN-COMPUTERWORLD-LAYOFFS",
                verbatim_quote=(
                    "9% of the global team, as part of a restructuring plan"
                ),
                metric="layoffs", direction="down",
                magnitude_text="~9% of global headcount",
                period="Feb 2025",
                as_of_date=date(2025, 2, 6),
            ),
        ],
    ),

    # ---- WARN regulatory filing ----
    SourceExtraction(
        source_id="ASAN-WARN-FEB25",
        financial_signals=[
            FinancialSignal(
                source_id="ASAN-WARN-FEB25",
                verbatim_quote=(
                    "Asana, Inc. laid off 77 employees in San Francisco, CA"
                ),
                metric="layoffs", direction="down",
                magnitude_text="77 SF roles per WARN",
                period="Feb 2025",
                as_of_date=date(2025, 2, 6),
            ),
        ],
    ),

    # ---- AI Studio help/pricing page ----
    SourceExtraction(
        source_id="ASAN-AISTUDIO-HELP",
        product_launches=[
            ProductLaunch(
                source_id="ASAN-AISTUDIO-HELP",
                verbatim_quote=(
                    "AI Studio Plus (paid add-on for individuals and small teams)"
                ),
                product_name="AI Studio (tiered pricing: Basic / Plus / Pro)",
                launch_date=date(2025, 11, 1),
                stated_purpose_quote=(
                    "AI Studio Plus (paid add-on for individuals and small teams)"
                ),
            ),
        ],
    ),

    # ---- Intentionally-wrong quotes — verifier should strip these ----
    SourceExtraction(
        source_id="ASAN-PR-FY26Q4",
        exec_statements=[
            ExecStatement(
                source_id="ASAN-PR-FY26Q4",
                verbatim_quote="we will acquire Monday.com next quarter",
                speaker_name="Dan Rogers", speaker_title="CEO",
                forum="press_release",
                statement_date=date(2026, 3, 2),
            ),
        ],
        leadership_changes=[
            LeadershipChange(
                source_id="ASAN-PR-FY26Q4",
                verbatim_quote="appointed Sundar Pichai as new chair",
                person="Sundar Pichai",
                role="Chair",
                change_type="hired",
            ),
        ],
    ),
]


# ---------------------------------------------------------------------------
# Run the verifier + renderer for real.
# ---------------------------------------------------------------------------

def main():
    gaps = [
        "No active class-action securities litigation surfaced in coverage window.",
        "No earnings-call transcript text was hydrated (search adapter returned summary only).",
        "No public CFO interview surfaced; CFO statement coverage is press-release-only.",
        "No verified customer-name wins (only aggregate $100k+ cohort growth) — probe in discovery.",
    ]

    vf = V.verify(
        EXTRACTIONS, SOURCES,
        company="Asana", ticker="ASAN", ae="J. Chen",
        meeting_date=date(2026, 5, 9),
        # 18 months back — recaptures the June 2025 CEO transition and the
        # Feb 2025 layoffs, both still relevant context for a May 2026 call.
        coverage_window_start=date(2024, 11, 7),
        coverage_window_end=date(2026, 5, 7),
        gaps=gaps,
    )

    out_dir = ROOT / "examples" / "ASAN"
    out_dir.mkdir(parents=True, exist_ok=True)

    md = R.render_template(vf)
    (out_dir / "brief.md").write_text(md)

    # Persist facts (without source `text`) for audit
    (out_dir / "facts.json").write_text(
        vf.model_dump_json(
            indent=2,
            exclude={"sources": {"__all__": {"text"}}},
        )
    )

    # Sources packet (separate file for handy review)
    src_lines = ["# Sources used in Asana brief", ""]
    for i, s in enumerate(vf.sources, 1):
        src_lines.append(
            f"S{i} [{s.type}] {s.publisher} — "
            f"{s.publish_date.isoformat() if s.publish_date else '?'} — "
            f"{s.title}\n  {s.url}"
        )
    (out_dir / "sources.md").write_text("\n".join(src_lines))

    # Verifier summary
    print("=" * 70)
    print(f"VERIFIER REPORT")
    print("=" * 70)
    print(f"  quotes checked : {vf.verifier_log.quotes_checked}")
    print(f"  quotes passed  : {vf.verifier_log.quotes_passed}")
    print(f"  stripped       : {len(vf.verifier_log.stripped)}")
    for s in vf.verifier_log.stripped:
        print(f"    - [{s['fact_kind']}] {s['source_id']}: {s['quote'][:60]!r}")
    print()
    print(f"  unique facts   : {len(vf.facts)}")
    print(f"  → wrote {out_dir/'brief.md'}")
    print(f"  → wrote {out_dir/'facts.json'}")
    print(f"  → wrote {out_dir/'sources.md'}")
    print()
    print("=" * 70)
    print("BRIEF")
    print("=" * 70)
    print(md)


if __name__ == "__main__":
    main()
