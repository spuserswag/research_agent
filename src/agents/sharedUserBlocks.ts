/**
 * Shared user-message helpers for the four downstream agents (Signal,
 * Risk, Writer, Verifier).
 *
 * In Crawler2 (OpenAI SDK), prompt caching is not available, so the
 * cache_control blocks from the Anthropic version are dropped. The
 * helpers still return TextBlock arrays for source compatibility with
 * the agent files — the runAgent() function joins them into a single
 * string before sending to the API.
 */

import type { TextBlock } from "../lib/agentClient.js";
import type { DraftBrief, Lead, Risks, Signals, SourcePack } from "../types.js";

/**
 * User message for the Signal Extractor and Risk Detector — both
 * consume only the SourcePack.
 */
export function sourcePackUserBlocks(
  sourcePack: SourcePack,
  instruction: string,
): TextBlock[] {
  return [
    { type: "text", text: `SourcePack:\n${JSON.stringify(sourcePack, null, 2)}` },
    { type: "text", text: instruction },
  ];
}

/**
 * User message for the Personalization Writer — needs Lead, SourcePack,
 * Signals, and Risks.
 */
export function writerUserBlocks(args: {
  lead: Lead;
  sourcePack: SourcePack;
  signals: Signals;
  risks: Risks;
}): TextBlock[] {
  return [
    { type: "text", text: `SourcePack:\n${JSON.stringify(args.sourcePack, null, 2)}` },
    {
      type: "text",
      text:
        `Lead:\n${JSON.stringify(args.lead, null, 2)}\n\n` +
        `Signals:\n${JSON.stringify(args.signals, null, 2)}\n\n` +
        `Risks:\n${JSON.stringify(args.risks, null, 2)}\n\n` +
        `Write the brief now.`,
    },
  ];
}

/**
 * User message for the QA Verifier — needs the DraftBrief + SourcePack.
 */
export function verifierUserBlocks(args: {
  draft: DraftBrief;
  sourcePack: SourcePack;
}): TextBlock[] {
  return [
    { type: "text", text: `SourcePack:\n${JSON.stringify(args.sourcePack, null, 2)}` },
    {
      type: "text",
      text:
        `Draft brief to verify:\n${JSON.stringify(args.draft, null, 2)}\n\n` +
        `Verify each claim against the SourcePack snippets and emit a VerifiedBrief.`,
    },
  ];
}
