/**
 * Agent 3 — Risk Detector
 *
 * Scans the SourcePack for risk signals. No tools.
 *
 * The SourcePack is sent as a shared user content block across
 * the four downstream agents. Note: OpenAI has no prompt-caching
 * equivalent; the block is re-sent on every API call.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type AgentResult, runAgentWithSchema } from "../lib/agentClient.js";
import { type Risks, RisksSchema, type SourcePack } from "../types.js";
import { sourcePackUserBlocks } from "./sharedUserBlocks.js";

const PROMPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../prompts/riskDetector.md",
);

let _cachedPrompt: string | undefined;

export async function runRiskDetector(
  sourcePack: SourcePack,
): Promise<AgentResult<Risks>> {
  const systemPrompt = (_cachedPrompt ??= await readFile(PROMPT_PATH, "utf8"));

  return runAgentWithSchema(
    {
      systemPrompt,
      userMessage: sourcePackUserBlocks(sourcePack, "Detect risks."),
      maxTokens: 4000,
    },
    RisksSchema,
  );
}
