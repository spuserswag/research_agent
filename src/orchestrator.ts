/**
 * Pipelines the five agents and writes a company profile folder.
 *
 * Output layout (per run):
 *
 *   <profilesDir>/<companySlug>/<runId>/
 *     ├── brief.md                 ← the deliverable
 *     ├── run.json                 ← lead, timing, status
 *     └── research/
 *         ├── sources.json
 *         ├── signals.json
 *         ├── risks.json
 *         ├── draft-brief.json
 *         └── verified-brief.json
 *
 * Multiple runs for the same prospect stack neatly under the company slug.
 *
 * Failure policy: any uncaught error in an agent is logged into run.json
 * and rethrown. The run folder is created up-front so you can inspect
 * partial outputs even on failure.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "./config.js";
import type {
  Lead,
  RunRecord,
  VerifiedBrief,
} from "./types.js";
import { runResearcher } from "./agents/researcher.js";
import { runSignalExtractor } from "./agents/signalExtractor.js";
import { runRiskDetector } from "./agents/riskDetector.js";
import { runPersonalizationWriter } from "./agents/personalizationWriter.js";
import { runQaVerifier } from "./agents/qaVerifier.js";
import { renderBrief } from "./lib/briefRenderer.js";
import { addUsage } from "./lib/agentClient.js";
import { resetLedger, getLedgerEntries, getCostSummary } from "./lib/costLedger.js";
import { resetFirecrawlCap } from "./tools/firecrawl.js";

// ---------- Progress display ----------

const STAGES = [
  "Researcher",
  "Signals + Risks",
  "Writer",
  "Verifier",
  "Saving",
] as const;

const TOTAL = STAGES.length;
const BAR_WIDTH = 28;

let _stageStart = Date.now();
let _runStart = Date.now();
let _spinnerTimer: ReturnType<typeof setInterval> | undefined;
let _currentLabel = "";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let _spinIdx = 0;

function startSpinner(label: string): void {
  _currentLabel = label;
  _spinIdx = 0;
  _spinnerTimer = setInterval(() => {
    const elapsed = ((Date.now() - _stageStart) / 1000).toFixed(1);
    process.stdout.write(`\r${SPINNER[_spinIdx % SPINNER.length]!} ${_currentLabel}  ${elapsed}s  `);
    _spinIdx++;
  }, 100);
}

function stopSpinner(): void {
  if (_spinnerTimer) {
    clearInterval(_spinnerTimer);
    _spinnerTimer = undefined;
  }
}

function bar(done: number): string {
  const filled = Math.round((done / TOTAL) * BAR_WIDTH);
  return "[" + "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled) + "]";
}

function progressStart(stageIndex: number): void {
  stopSpinner();
  const label = STAGES[stageIndex] ?? "Running";
  const pct = Math.round((stageIndex / TOTAL) * 100);
  process.stdout.write(`\r${bar(stageIndex)} ${pct}%\n`);
  _stageStart = Date.now();
  startSpinner(`[${stageIndex + 1}/${TOTAL}] ${label}`);
}

function progressDone(stageIndex: number, note?: string): void {
  stopSpinner();
  const elapsed = ((Date.now() - _stageStart) / 1000).toFixed(1);
  const label = STAGES[stageIndex] ?? "Done";
  process.stdout.write(`\r✓ [${stageIndex + 1}/${TOTAL}] ${label}  ${elapsed}s${note ? `  — ${note}` : ""}\n`);
}

function progressFinish(openaiUsage?: { inputTokens: number; outputTokens: number }): void {
  stopSpinner();
  const total = ((Date.now() - _runStart) / 1000).toFixed(1);
  process.stdout.write(`\r${bar(TOTAL)} 100%\n`);
  process.stdout.write(`\n✅ Done in ${total}s\n`);

  // Cost breakdown table.
  const summary = getCostSummary(openaiUsage);
  if (summary.lines.length > 0) {
    process.stdout.write(`\n💰 API Costs\n`);
    const COL = 38;
    for (const line of summary.lines) {
      const hasTokens = line.inputTokens > 0 || line.outputTokens > 0;
      const detail = hasTokens
        ? `${fmtNum(line.calls)} call${line.calls !== 1 ? "s" : ""}  ${fmtNum(line.inputTokens)} in / ${fmtNum(line.outputTokens)} out`
        : `${fmtNum(line.calls)} call${line.calls !== 1 ? "s" : ""}`;
      const cost = `$${line.costUsd.toFixed(3)}`;
      process.stdout.write(`   ${line.label.padEnd(COL)}${detail.padEnd(34)}${cost}\n`);
    }
    process.stdout.write(`   ${"─".repeat(COL + 34 + 6)}\n`);
    process.stdout.write(`   ${"Total".padEnd(COL)}${"".padEnd(34)}$${summary.totalCostUsd.toFixed(3)}\n`);
  }
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

export interface OrchestratorResult {
  verified: VerifiedBrief;
  /** Absolute path to the profile run folder. */
  profilePath: string;
  /** Absolute path to brief.md inside the profile folder. */
  briefPath: string;
}

export async function runOrchestrator(leadIn: Lead): Promise<OrchestratorResult> {
  const config = getConfig();

  // Resolve identifiers + paths.
  const companySlug = slugify(leadIn.company);
  const runId = leadIn.runId ?? buildRunId();
  const lead: Lead = { ...leadIn, runId };

  const profilesDir = path.resolve(config.profilesDir);
  const profilePath = path.join(profilesDir, companySlug, runId);
  const researchDir = path.join(profilePath, "research");
  await mkdir(researchDir, { recursive: true });

  const record: RunRecord = {
    runId,
    startedAt: new Date().toISOString(),
    lead,
  };

  _runStart = Date.now();
  resetLedger();
  resetFirecrawlCap();
  process.stdout.write(`\nPreparing brief for ${lead.company}\n\n`);

  try {
    // 1. Researcher → SourcePack
    progressStart(0);
    const { result: sourcePack, usage: researcherUsage } = await runResearcher(lead);
    record.sourcePack = sourcePack;
    await writeJson(path.join(researchDir, "sources.json"), sourcePack);
    progressDone(0, `${sourcePack.sources.length} sources`);

    // 2. + 3. Signal & Risk run in parallel — both consume only the SourcePack.
    progressStart(1);
    const [
      { result: signals, usage: signalUsage },
      { result: risks, usage: riskUsage },
    ] = await Promise.all([
      runSignalExtractor(sourcePack).then((r) => {
        process.stdout.write(`\r   ✓ SignalExtractor — ${r.result.signals.length} signals\n`);
        return r;
      }),
      runRiskDetector(sourcePack).then((r) => {
        process.stdout.write(`\r   ✓ RiskDetector   — ${r.result.risks.length} risks\n`);
        return r;
      }),
    ]);
    record.signals = signals;
    record.risks = risks;
    await writeJson(path.join(researchDir, "signals.json"), signals);
    await writeJson(path.join(researchDir, "risks.json"), risks);
    progressDone(1, `${signals.signals.length} signals, ${risks.risks.length} risks`);

    // 4. Personalization Writer → DraftBrief
    progressStart(2);
    const { result: draft, usage: writerUsage } = await runPersonalizationWriter({
      lead,
      sourcePack,
      signals,
      risks,
    });
    record.draft = draft;
    await writeJson(path.join(researchDir, "draft-brief.json"), draft);
    progressDone(2);

    // 5. QA Verifier → VerifiedBrief
    progressStart(3);
    const { result: verified, usage: verifierUsage } = await runQaVerifier({
      draft,
      sourcePack,
      risks,
    });
    record.verified = verified;
    await writeJson(path.join(researchDir, "verified-brief.json"), verified);
    progressDone(3, verified.passedVerification ? "passed" : "⚠ flagged");

    // Accumulate per-stage telemetry.
    const total = addUsage(
      addUsage(addUsage(addUsage(researcherUsage, signalUsage), riskUsage), writerUsage),
      verifierUsage,
    );
    record.usage = {
      researcher: researcherUsage,
      signalExtractor: signalUsage,
      riskDetector: riskUsage,
      personalizationWriter: writerUsage,
      qaVerifier: verifierUsage,
      total,
    };

    // Capture cost data.
    const costSummary = getCostSummary(total);
    record.costs = {
      summary: costSummary,
      ledger: getLedgerEntries(),
    };

    // Render the brief (both markdown for humans and JSON for clients).
    progressStart(4);
    const rendered = renderBrief(lead, verified, sourcePack, risks);
    const briefPath = path.join(profilePath, "brief.md");
    const briefJsonPath = path.join(profilePath, "brief.json");
    await writeFile(briefPath, rendered.markdown, "utf8");
    await writeJson(briefJsonPath, rendered.published);
    record.finishedAt = new Date().toISOString();
    await writeJson(path.join(profilePath, "run.json"), record);
    progressDone(4);
    progressFinish(total);

    return { verified, profilePath, briefPath };
  } catch (err) {
    stopSpinner();
    record.error = err instanceof Error ? err.message : String(err);
    record.finishedAt = new Date().toISOString();
    await writeJson(path.join(profilePath, "run.json"), record);
    throw err;
  }
}

async function writeJson(p: string, data: unknown): Promise<void> {
  await writeFile(p, JSON.stringify(data, null, 2), "utf8");
}

function buildRunId(): string {
  // ISO timestamp, filesystem-safe.
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "unknown"
  );
}
