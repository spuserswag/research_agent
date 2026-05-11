/**
 * Agent 4 — Personalization Writer
 *
 * Turns signals + risks + lead context into a discovery-ready DraftBrief.
 * No tools. Constrained by the prompt + downstream verifier.
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
  DraftBriefSchema,
  type Lead,
  type Risks,
  type Signals,
  type SourcePack,
} from "../types.js";
import { writerUserBlocks } from "./sharedUserBlocks.js";

const PROMPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../prompts/personalizationWriter.md",
);

export interface WriterInput {
  lead: Lead;
  sourcePack: SourcePack;
  signals: Signals;
  risks: Risks;
}

let _cachedPrompt: string | undefined;

export async function runPersonalizationWriter(
  input: WriterInput,
): Promise<AgentResult<DraftBrief>> {
  const systemPrompt = (_cachedPrompt ??= await readFile(PROMPT_PATH, "utf8"));

  return runAgentWithSchema(
    {
      systemPrompt,
      userMessage: writerUserBlocks(input),
      // The Writer does the most synthesis — bump model here if briefs feel flat.
      // model: "claude-opus-4-6",
      maxTokens: 8000,
    },
    DraftBriefSchema,
  );
}
