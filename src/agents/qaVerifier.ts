/**
 * Agent 5 — QA / Fact Verifier
 *
 * Checks every claim in the DraftBrief against cited source snippets.
 * No tools. Pure text-vs-snippet check.
 *
 * Shared user block: SourcePack (same one used across downstream agents).
 * Note: OpenAI has no prompt-caching equivalent.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type AgentResult, runAgentWithSchema } from "../lib/agentClient.js";
import {
  type DraftBrief,
  type SourcePack,
  type VerifiedBrief,
  VerifiedBriefSchema,
} from "../types.js";
import { verifierUserBlocks } from "./sharedUserBlocks.js";

const PROMPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../prompts/qaVerifier.md",
);

export interface VerifierInput {
  draft: DraftBrief;
  sourcePack: SourcePack;
}

let _cachedPrompt: string | undefined;

export async function runQaVerifier(
  input: VerifierInput,
): Promise<AgentResult<VerifiedBrief>> {
  const systemPrompt = (_cachedPrompt ??= await readFile(PROMPT_PATH, "utf8"));

  return runAgentWithSchema(
    {
      systemPrompt,
      userMessage: verifierUserBlocks(input),
      maxTokens: 10000,
    },
    VerifiedBriefSchema,
  );
}
