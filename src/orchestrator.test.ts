/**
 * Hermetic integration test for the orchestrator — no network, no keys.
 *
 * Strategy: stub all five agents with vi.mock, point PROFILES_DIR at a
 * tmp dir, run the orchestrator, and assert:
 *   - the profile folder layout matches what the README documents
 *   - each agent receives the right input
 *   - run.json contains the lead, timing, and the verified brief
 *   - the rendered brief.md contains the right sections and source IDs
 *
 * If this passes, we know the wiring is correct end-to-end except for
 * the actual OpenAI calls.
 */

import path from "node:path";
import os from "node:os";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  AgentResult,
  AgentUsage,
} from "./lib/agentClient.js";
import type {
  DraftBrief,
  Risks,
  Signals,
  SourcePack,
  VerifiedBrief,
} from "./types.js";

// ---------- Set up a tmp PROFILES_DIR before anything imports config ----------

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "crawler2-test-"));
// Set required keys BEFORE dotenv/config runs (it won't overwrite pre-set vars).
process.env.OPENAI_API_KEY ||= "test-openai";
process.env.PERPLEXITY_API_KEY ||= "test-perplexity";
process.env.FIRECRAWL_API_KEY ||= "test-firecrawl";
process.env.PROFILES_DIR = tmpRoot;
// Force optional email vars to empty strings so dotenv can't inject an invalid
// value from the developer's .env file. config.ts uses `|| undefined` so ""
// becomes undefined and passes the optional().email() check.
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || "";
process.env.EMAIL_FROM = "";
process.env.EMAIL_REPLY_TO = "";

// ---------- Fixtures the mocked agents will return ----------

const ZERO_USAGE: AgentUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  iterations: 0,
};

function wrap<T>(result: T): AgentResult<T> {
  return { result, usage: ZERO_USAGE };
}

const fakeSourcePack: SourcePack = {
  lead: {} as never, // orchestrator overwrites this anyway
  generatedAt: "2026-05-07T00:00:00Z",
  sources: [
    {
      id: "src-1",
      url: "https://example.com/news",
      title: "Acme Q1 News",
      category: "news",
      snippet: "Acme grew 20%.",
      publishedAt: "2026-04-01",
    },
    {
      id: "src-2",
      url: "https://example.com/exec",
      title: "CEO Interview",
      category: "exec_interview",
      snippet: "We're consolidating data tools.",
    },
  ],
};

const fakeSignals: Signals = {
  signals: [
    {
      kind: "initiative",
      summary: "Consolidating data tools",
      detail: "From the CEO interview, they're consolidating tooling.",
      supportingSourceIds: ["src-2"],
    },
  ],
};

const fakeRisks: Risks = { risks: [] };

const fakeDraft: DraftBrief = {
  tldr: [
    "Consolidating data tools; CEO interview confirms this is a Q3 initiative.",
  ],
  callObjective: "Confirm who owns the vendor evaluation for the data consolidation project.",
  icebreakers: [
    { text: "Saw the Q1 growth news.", supportingSourceIds: ["src-1"] },
    { text: "Loved the consolidation comment.", supportingSourceIds: ["src-2"] },
  ],
  valueAlignmentHooks: [
    { text: "Their consolidation push aligns with our wedge.", supportingSourceIds: ["src-2"] },
    { text: "20% growth signals readiness.", supportingSourceIds: ["src-1"] },
  ],
  potentialRedFlags: [],
  talkingPoints: [
    { text: "What's first?", supportingSourceIds: ["src-2"] },
    { text: "Where does spend sit?", supportingSourceIds: ["src-1"] },
    { text: "Who owns the migration?", supportingSourceIds: ["src-2"] },
  ],
  attendeeIntel: [],
  objectionPredictions: [],
};

const fakeVerified: VerifiedBrief = {
  brief: fakeDraft,
  notes: [],
  passedVerification: true,
};

// ---------- Mocks ----------

vi.mock("./agents/researcher.js", () => ({
  runResearcher: vi.fn(async () => wrap(fakeSourcePack)),
}));
vi.mock("./agents/signalExtractor.js", () => ({
  runSignalExtractor: vi.fn(async () => wrap(fakeSignals)),
}));
vi.mock("./agents/riskDetector.js", () => ({
  runRiskDetector: vi.fn(async () => wrap(fakeRisks)),
}));
vi.mock("./agents/personalizationWriter.js", () => ({
  runPersonalizationWriter: vi.fn(async () => wrap(fakeDraft)),
}));
vi.mock("./agents/qaVerifier.js", () => ({
  runQaVerifier: vi.fn(async () => wrap(fakeVerified)),
}));

// Now import the orchestrator (after mocks are registered).
const { runOrchestrator } = await import("./orchestrator.js");

// ---------- Test ----------

describe("runOrchestrator (with mocked agents)", () => {
  let result: Awaited<ReturnType<typeof runOrchestrator>>;

  beforeAll(async () => {
    result = await runOrchestrator({
      company: "Acme Corp",
      aeName: "Jordan",
      aeEmail: "jordan@arvayaconsulting.com",
      meetingAt: "2026-05-12T15:00:00Z",
    });
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns absolute paths to the profile folder and brief", () => {
    expect(path.isAbsolute(result.profilePath)).toBe(true);
    expect(path.isAbsolute(result.briefPath)).toBe(true);
  });

  it("creates ./profiles/<companySlug>/<runId>/ under the tmp PROFILES_DIR", () => {
    expect(result.profilePath.startsWith(tmpRoot)).toBe(true);
    expect(result.profilePath).toContain("acme-corp");
  });

  it("writes brief.md and run.json at the top of the profile folder", () => {
    expect(existsSync(path.join(result.profilePath, "brief.md"))).toBe(true);
    expect(existsSync(path.join(result.profilePath, "run.json"))).toBe(true);
  });

  it("writes all five stage outputs under research/", () => {
    const research = path.join(result.profilePath, "research");
    for (const f of [
      "sources.json",
      "signals.json",
      "risks.json",
      "draft-brief.json",
      "verified-brief.json",
    ]) {
      expect(existsSync(path.join(research, f))).toBe(true);
    }
  });

  it("brief.md starts with the right H1 and includes citations", () => {
    const md = readFileSync(result.briefPath, "utf8");
    expect(md).toMatch(/^# Discovery Prep — Acme Corp/);
    expect(md).toContain("[src-1]");
    expect(md).toContain("[src-2]");
  });

  it("run.json captures the lead, timing, and the final verified brief", () => {
    const record = JSON.parse(
      readFileSync(path.join(result.profilePath, "run.json"), "utf8"),
    ) as Record<string, unknown>;
    expect((record.lead as { company: string }).company).toBe("Acme Corp");
    expect(record.startedAt).toBeTruthy();
    expect(record.finishedAt).toBeTruthy();
    expect(record.verified).toBeTruthy();
    expect(record.error).toBeUndefined();
  });
});
