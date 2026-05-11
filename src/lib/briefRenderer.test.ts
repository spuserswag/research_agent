/**
 * Hermetic tests for briefRenderer — no network, no keys.
 *
 * Goal: the markdown shape the AE will read is stable. We don't pin
 * exact whitespace; we assert presence of the load-bearing pieces.
 */

import { describe, expect, it } from "vitest";
import { renderBrief } from "./briefRenderer.js";
import type { Lead, SourcePack, VerifiedBrief } from "../types.js";

const lead: Lead = {
  runId: "test-run",
  company: "Northwind Logistics",
  aeName: "Jordan",
  aeEmail: "jordan@arvayaconsulting.com",
  meetingAt: "2026-05-12T15:00:00Z",
};

const sourcePack: SourcePack = {
  lead,
  generatedAt: "2026-05-07T20:00:00Z",
  sources: [
    {
      id: "src-1",
      url: "https://example.com/q1",
      title: "Q1 Earnings",
      category: "filing",
      snippet: "Revenue up 12 percent.",
      publishedAt: "2026-04-22",
    },
    {
      id: "src-2",
      url: "https://example.com/post",
      title: "VP Data on LinkedIn",
      category: "social",
      snippet: "Relocating data org to Charlotte.",
    },
    {
      id: "src-99",
      url: "https://example.com/unused",
      title: "Unused source",
      category: "news",
      snippet: "Should not appear.",
    },
  ],
};

const verified: VerifiedBrief = {
  brief: {
    tldr: [
      "Data org relocating to Charlotte; Q1 earnings show 12% revenue growth.",
      "No active risk signals detected.",
    ],
    callObjective: "Confirm who owns the data migration and whether the budget is approved.",
    icebreakers: [
      { text: "Saw the Charlotte relocation post.", supportingSourceIds: ["src-2"] },
      { text: "Q1 numbers looked strong.", supportingSourceIds: ["src-1"] },
    ],
    valueAlignmentHooks: [
      { text: "Data org consolidation aligns with our wedge.", supportingSourceIds: ["src-2"] },
      { text: "Their growth signals readiness.", supportingSourceIds: ["src-1"] },
    ],
    potentialRedFlags: [],
    talkingPoints: [
      { text: "What's the first-90-day mandate?", supportingSourceIds: ["src-2"] },
      { text: "How is the data migration tracking?", supportingSourceIds: ["src-2"] },
      { text: "Where does Snowflake spend land?", supportingSourceIds: ["src-1"] },
    ],
    attendeeIntel: [],
    objectionPredictions: [
      {
        objection: "We're going to build this in-house.",
        suggestedResponse: "We augment the team on evals.",
        supportingSourceIds: ["src-2"],
      },
    ],
  },
  notes: [],
  passedVerification: true,
};

describe("renderBrief", () => {
  const { markdown } = renderBrief(lead, verified, sourcePack);

  it("starts with a company-titled H1", () => {
    expect(markdown).toMatch(/^# Discovery Prep — Northwind Logistics/);
  });

  it("includes meeting metadata and AE name", () => {
    expect(markdown).toContain("AE: Jordan");
    expect(markdown).toContain("Meeting:");
    expect(markdown).toContain("2026"); // year is now in the formatted date
  });

  it("renders all required sections including TL;DR and Call Objective", () => {
    for (const heading of [
      "## TL;DR",
      "## Call Objective",
      "## Icebreakers",
      "## Value Alignment Hooks",
      "## Potential Red Flags",
      "## Talking Points",
      "## Objection Predictions",
    ]) {
      expect(markdown).toContain(heading);
    }
  });

  it("renders TL;DR as a blockquote call objective and bullet list", () => {
    expect(markdown).toContain("## TL;DR");
    expect(markdown).toContain("## Call Objective");
    expect(markdown).toContain("Confirm who owns");
  });

  it("renders empty sections as _None._ rather than dropping them", () => {
    expect(markdown).toContain("## Potential Red Flags\n\n_None._");
  });

  it("inlines source IDs after each item", () => {
    expect(markdown).toContain("[src-1]");
    expect(markdown).toContain("[src-2]");
  });

  it("renders objections in 'They might say / You can respond' form", () => {
    expect(markdown).toContain("**They might say:**");
    expect(markdown).toContain("**You can respond:**");
  });

  it("emits a Sources section listing only referenced sources", () => {
    expect(markdown).toContain("## Sources");
    expect(markdown).toContain("src-1");
    expect(markdown).toContain("src-2");
    expect(markdown).not.toContain("src-99"); // unreferenced
    expect(markdown).not.toContain("Unused source");
  });

  it("warns at the end when verification fails", () => {
    const failed = renderBrief(
      lead,
      { ...verified, passedVerification: false },
      sourcePack,
    ).markdown;
    expect(failed).toContain("did not fully pass automated fact verification");
  });

  it("does not warn when verification passes", () => {
    expect(markdown).not.toContain("did not fully pass automated fact verification");
  });
});
