/**
 * Shared OpenAI client and agentic loop.
 *
 * Wraps the OpenAI Chat Completions API with a tool-dispatch loop that
 * mirrors the interface originally built for the Anthropic SDK, so all
 * five agents and the orchestrator need no changes when switching models.
 *
 * Note: this file was previously named claudeClient.ts (a leftover from
 * the Anthropic-SDK era). It was renamed to agentClient.ts in May 2026
 * to reflect that it now wraps OpenAI, not Claude/Anthropic.
 *
 * API mapping (Anthropic → OpenAI):
 *   client.messages.create()      → client.chat.completions.create()
 *   system param                  → { role: "system", content } first message
 *   stop_reason "tool_use"        → finish_reason "tool_calls"
 *   content[].type "tool_use"     → message.tool_calls[].type "function"
 *   { type: "tool_result", ... }  → { role: "tool", tool_call_id, content }
 *   usage.input_tokens            → usage.prompt_tokens
 *   usage.output_tokens           → usage.completion_tokens
 *   cache_control / cacheSystemPrompt → not supported; silently ignored
 *
 * ServerTool (Anthropic-only concept) is accepted in the args type for
 * source compatibility but has no effect — OpenAI has no equivalent
 * server-side tools. Pass an empty array or omit it.
 *
 * Default model: gpt-4o.
 */

import OpenAI from "openai";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodSchema, ZodTypeAny } from "zod";

import { getConfig } from "../config.js";
import { extractJson } from "./jsonExtract.js";

// ---------- Types ----------

/** Thin content-block type used by sharedUserBlocks helpers. */
export type TextBlock = { type: "text"; text: string };

/**
 * Server-tool descriptor — retained for source-level compatibility with
 * the Anthropic version. OpenAI has no equivalent; values are ignored.
 */
export interface ServerTool {
  type: string;
  name: string;
  [extra: string]: unknown;
}

export interface CustomTool<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: ZodTypeAny;
  handler: (input: I) => Promise<O>;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  /** Always 0 — OpenAI has no prompt-caching equivalent. */
  cacheCreationInputTokens: number;
  /** Always 0 — OpenAI has no prompt-caching equivalent. */
  cacheReadInputTokens: number;
  /** Number of round-trips with the API made for this agent run. */
  iterations: number;
}

export interface AgentResponse {
  text: string;
  usage: AgentUsage;
}

export interface AgentResult<T> {
  result: T;
  usage: AgentUsage;
}

export interface RunAgentArgs {
  systemPrompt: string;
  /**
   * The first user message. Either a plain string or an array of
   * TextBlock objects. Blocks are joined with double newlines.
   * (The Anthropic version supports cache_control blocks; those
   * fields are silently ignored here.)
   */
  userMessage: string | TextBlock[];
  /** Accepted for compatibility — ignored at runtime. */
  serverTools?: ReadonlyArray<ServerTool>;
  customTools?: ReadonlyArray<CustomTool<any, any>>;
  /** Defaults to gpt-4o. */
  model?: string;
  /** Cap on output tokens. Default 8192. */
  maxTokens?: number;
  /** Safety cap on agentic iterations. Default 12. */
  maxIterations?: number;
  /**
   * Accepted for compatibility — OpenAI has no prompt caching;
   * silently ignored.
   */
  cacheSystemPrompt?: boolean;
}

// ---------- Client ----------

let cachedClient: OpenAI | undefined;

function client(): OpenAI {
  if (!cachedClient) {
    cachedClient = new OpenAI({ apiKey: getConfig().openaiApiKey });
  }
  return cachedClient;
}

// ---------- Helpers ----------

function userContent(msg: string | TextBlock[]): string {
  if (typeof msg === "string") return msg;
  return msg.map((b) => b.text).join("\n\n");
}

// ---------- Main loop ----------

type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;
type ToolCallBlock = OpenAI.Chat.ChatCompletionMessageToolCall;

/**
 * Run a single OpenAI agent with optional tool use, return the final
 * assistant text and accumulated token usage.
 */
export async function runAgent(args: RunAgentArgs): Promise<AgentResponse> {
  const {
    systemPrompt,
    userMessage,
    customTools = [],
    model = "gpt-4o",
    maxTokens = 8192,
    maxIterations = 12,
  } = args;

  // Build the OpenAI tools array from custom tools only.
  const tools: OpenAI.Chat.ChatCompletionTool[] = customTools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: zodToJsonSchema(t.inputSchema, {
        target: "openApi3",
      }) as Record<string, unknown>,
    },
  }));

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent(userMessage) },
  ];

  const customToolByName = new Map(customTools.map((t) => [t.name, t]));

  const usage: AgentUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    iterations: 0,
  };

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    usage.iterations++;

    const response = await client().chat.completions.create({
      model,
      max_tokens: maxTokens,
      tools: tools.length > 0 ? tools : undefined,
      messages,
    });

    // Accumulate token usage.
    if (response.usage) {
      usage.inputTokens += response.usage.prompt_tokens;
      usage.outputTokens += response.usage.completion_tokens;
    }

    const choice = response.choices[0];
    if (!choice) {
      throw new Error(
        `OpenAI returned no choices (model=${model}, iteration=${iteration}). ` +
          "This can happen on content-filtered responses or unexpected API errors.",
      );
    }
    const assistantMessage = choice.message;

    // Always append the assistant turn before any tool results.
    messages.push(assistantMessage);

    if (choice.finish_reason !== "tool_calls" || !assistantMessage.tool_calls?.length) {
      return { text: assistantMessage.content ?? "", usage };
    }

    // Dispatch each tool call and append results.
    for (const tc of assistantMessage.tool_calls) {
      const def = customToolByName.get(tc.function.name);
      if (!def) {
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: `Unknown tool: ${tc.function.name}`,
        });
        continue;
      }

      try {
        const parsed = JSON.parse(tc.function.arguments) as unknown;
        const validated = def.inputSchema.parse(parsed);
        const result = await def.handler(validated);
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: typeof result === "string" ? result : JSON.stringify(result),
        });
      } catch (err) {
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  // Log the full message history before throwing so any paid tool-call context
  // (e.g. Perplexity results already fetched) isn't silently lost.
  // eslint-disable-next-line no-console
  console.error(
    `runAgent: exceeded maxIterations (${maxIterations}). ` +
      `Last ${messages.length} messages:\n` +
      JSON.stringify(messages.slice(-4), null, 2),
  );
  throw new Error(`runAgent: exceeded maxIterations (${maxIterations})`);
}

/**
 * Run an agent and parse its output against a Zod schema. On parse
 * failure, retry once with the validation error fed back to the model.
 */
export async function runAgentWithSchema<T>(
  args: RunAgentArgs,
  schema: ZodSchema<T>,
): Promise<AgentResult<T>> {
  const first = await runAgent(args);
  try {
    const parsed = schema.parse(extractJson(first.text));
    return { result: parsed, usage: first.usage };
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);

    // Intentionally omit customTools on retry: the model already has all the
    // information it gathered in `first.text` — we only need it to reformat
    // that output as valid JSON, not invoke further tool calls. Passing tools
    // here would risk the model making additional (paid) API calls instead of
    // just fixing its JSON structure.
    const retry = await runAgent({
      systemPrompt:
        args.systemPrompt +
        "\n\nIMPORTANT: Your previous response failed JSON validation. Return ONLY a valid JSON object matching the original schema. No prose, no markdown, no code fences.",
      userMessage: `Previous output:\n${first.text}\n\nValidation error:\n${errMessage}\n\nReturn the corrected JSON now.`,
      model: args.model,
      maxTokens: args.maxTokens,
      cacheSystemPrompt: false,
    });

    const parsed = schema.parse(extractJson(retry.text));
    return {
      result: parsed,
      usage: addUsage(first.usage, retry.usage),
    };
  }
}

// ---------- Utilities ----------

export function addUsage(a: AgentUsage, b: AgentUsage): AgentUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    iterations: a.iterations + b.iterations,
  };
}

export const ZERO_USAGE: AgentUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  iterations: 0,
};
