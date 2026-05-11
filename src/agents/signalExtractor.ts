/**
 * Agent 2 — Signal Extractor
 *
 * Reads the SourcePack and pulls out strategic initiatives, pains,
 * tech-stack hints, and growth indicators. No tools. No network.
 *
 * The SourcePack is sent as a shared user content block across
 * the four downstream agents (Signal, Risk, Writer, Verifier).
 * Note: OpenAI has no prompt-caching equivalent; the block is re-sent
 * on every API call.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type AgentResult,
  runAgentWithSchema,
} from "../lib/agentClient.js";
import { type Signals, SignalsSchema, type SourcePack } from "../types.js";
import { sourcePackUserBlocks } from "./sharedUserBlocks.js";

const PROMPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../prompts/signalExtractor.md",
);

let _cachedPrompt: string | undefined;

export async function runSignalExtractor(
  sourcePack: SourcePack,
): Promise<AgentResult<Signals>> {
  const systemPrompt = (_cachedPrompt ??= await readFile(PROMPT_PATH, "utf8"));

  return runAgentWithSchema(
    {
      systemPrompt,
      userMessage: sourcePackUserBlocks(sourcePack, "Extract signals."),
      maxTokens: 6000,
    },
    SignalsSchema,
  );
}
