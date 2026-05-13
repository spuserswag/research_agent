/**
 * Agent 5 — QA / Fact Verifier
 *
 * Two-stage verification:
 *
 *  1. Deterministic pre-pass (src/lib/verify.ts) — pure-TS substring
 *     check of every claim's evidence quote against its cited sources.
 *     Catches the failure modes that LLMs reliably miss: hallucinated
 *     quotes, claims citing nonexistent source IDs, same-name impostor
 *     contamination. Runs in microseconds, no API call. Logged strips
 *     are surfaced in the VerificationNote list.
 *
 *  2. LLM pass — the historic agent that judges weaker classes of
 *     wrongness (claim that's verbatim in source but misinterpreted,
 *     overclaiming, etc). Only judges over what the deterministic pass
 *     kept.
 *
 * The two-pass shape mirrors what made the Python `prospect_brief`
 * pipeline defensible: the LLM is fenced into judgement calls that
 * actually require judgement; everything mechanically checkable is
 * checked by code first.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type AgentResult, runAgentWithSchema } from "../lib/agentClient.js";
import {
  type DraftBrief,
  type Risks,
  type SourcePack,
  type VerificationNote,
  type VerifiedBrief,
  VerifiedBriefSchema,
} from "../types.js";
import { verifierUserBlocks } from "./sharedUserBlocks.js";
import { verifyBriefAgainstSources } from "../lib/verify.js";
import { log } from "../lib/logger.js";

const PROMPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../prompts/qaVerifier.md",
);

export interface VerifierInput {
  draft: DraftBrief;
  sourcePack: SourcePack;
  /**
   * Optional Risks payload. If present, deterministic verifier checks
   * every risk's `evidenceQuote` against its cited sources before the
   * LLM verifier runs. Mechanically catches hallucinated risks.
   */
  risks?: Risks;
}

let _cachedPrompt: string | undefined;

/**
 * Run the deterministic pre-pass over the brief + risks. Returns notes
 * for every stripped claim so the orchestrator can log + persist them.
 * Pure function; does not mutate inputs.
 */
export function runDeterministicVerify(
  input: VerifierInput,
): VerificationNote[] {
  const result = verifyBriefAgainstSources(
    input.draft,
    input.risks?.risks ?? [],
    input.sourcePack,
  );

  if (result.stripped.length > 0) {
    log.info(
      `[qaVerifier] deterministic pre-pass stripped ` +
        `${result.stripped.length}/${result.checked} claim(s):`,
    );
    for (const s of result.stripped) {
      log.info(`  - ${s.location}: ${s.reason}`);
    }
  } else {
    log.info(
      `[qaVerifier] deterministic pre-pass: all ${result.checked} ` +
        `claim(s) cite real sources with matching evidence quotes`,
    );
  }

  return result.stripped.map((s) => ({
    location: s.location,
    status: "removed" as const,
    reason: `[deterministic] ${s.reason}`,
  }));
}

export async function runQaVerifier(
  input: VerifierInput,
): Promise<AgentResult<VerifiedBrief>> {
  // ---- Stage 1: deterministic pre-pass ----
  const deterministicNotes = runDeterministicVerify(input);

  // ---- Stage 2: LLM pass ----
  const systemPrompt = (_cachedPrompt ??= await readFile(PROMPT_PATH, "utf8"));

  const llmResult = await runAgentWithSchema(
    {
      systemPrompt,
      userMessage: verifierUserBlocks(input),
      maxTokens: 10000,
    },
    VerifiedBriefSchema,
  );

  // Merge deterministic strip notes into the LLM verifier's output.
  // The LLM should not be able to "undo" a deterministic strip — those
  // are mechanically-wrong claims and stay removed.
  llmResult.result.notes = [...deterministicNotes, ...llmResult.result.notes];

  // If the deterministic pass found anything, the brief did NOT pass
  // full verification — even if the LLM thought it did.
  if (deterministicNotes.length > 0 && llmResult.result.passedVerification) {
    log.info(
      `[qaVerifier] LLM marked brief as passing but deterministic pass ` +
        `stripped ${deterministicNotes.length} claim(s); overriding to false`,
    );
    llmResult.result.passedVerification = false;
  }

  return llmResult;
}
