/**
 * monday/synthesizer.ts
 *
 * Uses GPT-4o-mini to synthesize the "contextual" Lead fields that can't
 * be pulled from a column directly — things like hypothesis, callObjective,
 * and meetingContext — by reading ALL available Monday item data holistically.
 *
 * The synthesizer also attempts to fill in any enum fields (dealStage,
 * prospectArchetype, meetingType) that the rule-based mapper missed,
 * inferring them from unstructured notes/description columns.
 *
 * Only called when OPENAI_API_KEY is set in the environment.
 * The runner passes --ai to enable it.
 */

import OpenAI from "openai";
import type { MondayItem, MondayColumnValue } from "./types.js";

// The fields the synthesizer targets — ones that require interpretation
// rather than direct extraction.
const SYNTHESIZABLE_FIELDS = [
  "hypothesis",
  "callObjective",
  "meetingContext",
  "meetingType",
  "dealStage",
  "prospectArchetype",
  "introSource",
  "introContext",
  "productFocus",
  "engagementShape",
  "competitiveContext",
  "excludeKeywords",
] as const;

export type SynthesizedFields = Partial<{
  hypothesis: string;
  callObjective: string;
  meetingContext: string;
  meetingType: "first_intro" | "discovery" | "proposal_review" | "renewal" | "partnership_explore";
  dealStage: "cold" | "warm" | "evaluation";
  prospectArchetype: "aec_firm" | "aec_vendor" | "other";
  introSource: "inbound" | "referral" | "event" | "cold_outbound" | "reactivation";
  introContext: string;
  productFocus: string;
  engagementShape: string;
  competitiveContext: string[];
  excludeKeywords: string[];
}>;

/** Token usage + estimated cost for a single synthesis call. */
export interface SynthesisUsage {
  inputTokens: number;
  outputTokens: number;
  /** Estimated cost in USD (gpt-4o-mini rates: $0.15/1M in, $0.60/1M out) */
  estimatedCostUsd: number;
}

// gpt-4o-mini pricing (per 1M tokens)
const PRICE_INPUT_PER_M  = 0.15;
const PRICE_OUTPUT_PER_M = 0.60;

function calcCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * PRICE_INPUT_PER_M
       + (outputTokens / 1_000_000) * PRICE_OUTPUT_PER_M;
}

// ---------- Prompt builder ----------

function buildPrompt(
  item: MondayItem,
  directlyMapped: Record<string, unknown>,
  unmappedColumns: MondayColumnValue[],
  allColumns: MondayColumnValue[]
): string {
  // Format all column data for context
  const allData = allColumns
    .filter((c) => c.text?.trim())
    .map((c) => `  ${c.title}: ${c.text.trim()}`)
    .join("\n");

  const unmappedData = unmappedColumns
    .filter((c) => c.text?.trim())
    .map((c) => `  ${c.title}: ${c.text.trim()}`)
    .join("\n");

  const alreadyMapped = Object.entries(directlyMapped)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
    .join("\n");

  const fieldDefs = `
- hypothesis: 2-3 sentences — Arvaya's prior on the prospect's SPECIFIC pain and build-vs-buy tension.
    REQUIRE: at least 2 concrete signals from the notes (e.g. a named process gap, a tech they're using, a stated initiative).
    GOOD: "AKS uses BST Global for ERP but their PM team manually exports data for reporting. Their IT org is lean, so a partner-led integration sprint is more viable than internal build."
    BAD (do NOT write this): "AKS is likely facing challenges in scaling their operations. They may be looking for AI solutions."
    OMIT if you only have company name, archetype, or intro source — do not fabricate pain from thin data.

- callObjective: One sentence — what Arvaya wants to learn or CONFIRM on this specific call, not restate the meeting purpose.
    GOOD: "Validate whether the Q3 reporting initiative has budget attached and who owns the vendor evaluation."
    BAD: "Confirm the specific AI needs and explore their openness to partnerships."
    OMIT if there is no meeting date or the lead has no notes indicating a specific goal.

- meetingContext: 2-4 sentences — how this meeting came about, what the prospect signaled, what a win looks like.
    Only write this if there are actual meeting notes or intro context to work from. Do not invent narrative.

- meetingType: One of: first_intro | discovery | proposal_review | renewal | partnership_explore
    RULES — only set this if ALL of the following are true:
      1. There is a meeting date already extracted (meetingAt is set), OR the notes describe a specific scheduled meeting.
      2. The type is clear from the notes or board data — do not default to "discovery" for every lead.
    If the lead is cold with no meeting date, OMIT meetingType entirely.

- dealStage: One of: cold | warm | evaluation — only set if not already mapped.

- prospectArchetype: One of: aec_firm | aec_vendor | other — only set if not already mapped.
    aec_firm = general contractor, design firm, owner-operator, government agency doing construction/infrastructure.
    aec_vendor = software or SaaS company selling tools INTO the AEC industry.
    other = everything else (finance, healthcare, education, staffing, etc.).

- introSource: One of: inbound | referral | event | cold_outbound | reactivation — only set if not already mapped.

- introContext: Free-form qualifier on introSource (e.g., "Met at AECTech 2026" or "Referred by Pat Lee").
    Only set if not already mapped and you have specific detail.

- productFocus: The specific Arvaya product or service being positioned (e.g., "RFP automation", "AI readiness assessment").
    Only set if the notes mention a specific use case or engagement type. OMIT if you would have to guess.

- engagementShape: e.g., "fixed-scope discovery sprint", "advisory retainer", "implementation engagement".
    Only set if the notes or deal stage clearly indicate the engagement model. OMIT if guessing.

- competitiveContext: Array of NAMED competitors or specific alternative approaches explicitly mentioned in the notes.
    RULES:
      - Only include entries that appear in the board data — never guess or use generic defaults.
      - Do NOT include "in-house build", "other consulting firms", "local vendors" unless the notes explicitly name them.
      - If no competitive data exists in the notes, return an empty array [].
    GOOD example (only when notes mention it): ["BST Global"] — because meeting notes say they use BST Global.
    BAD: ["Slalom", "in-house build"] — these are guesses, never use as defaults.

- excludeKeywords: Array of strings to EXCLUDE from web search results to avoid disambiguation.
    RULES — this field has ONE purpose: preventing the Researcher from finding results about a DIFFERENT
    entity that happens to share the company's name. It is NOT for filtering out the company itself.
      - NEVER include the company name, abbreviations of it, or words that describe what the company does.
      - ONLY include terms if the company name is a common word/acronym that collides with an unrelated entity.
      - If uncertain, return an empty array [].
    GOOD: company is "Joist AI" → ["joist app", "consumer contractor"] (Joist is also a consumer contractor app)
    GOOD: company is "Oneida" → ["silverware", "flatware"] (Oneida is also a silverware brand)
    GOOD: company is "NHE" + notes mention affordable housing → ["affordable housing"] (disambiguates from residential)
    BAD: ["AKS"] — this IS the company, excluding it breaks all searches
    BAD: ["construction", "engineering"] — these describe the company's industry, not a collision`;

  return `You are helping prepare a sales discovery brief for Arvaya Consulting, an AI consulting firm.
Below is data from a Monday.com CRM board item for a prospect deal.

Your job: synthesize contextual Lead fields that require interpretation. Be specific and grounded —
every field you output must be supported by actual data in the board item below.
When in doubt, OMIT the field. A missing field is better than a fabricated one.

=== Monday Board Item ===
Item name: ${item.name}

All columns with data:
${allData || "  (none)"}

=== Columns not matched to a Lead field (richest synthesis material) ===
${unmappedData || "  (none — all columns were directly mapped)"}

=== Already extracted by direct column mapping (do NOT contradict or repeat these) ===
${alreadyMapped || "  (none yet)"}

=== Field definitions and rules ===
${fieldDefs}

=== Output format ===
Return ONLY a valid JSON object. No explanation, markdown, or commentary.
Include only the fields you can confidently infer from the data above.

competitiveContext and excludeKeywords must be arrays (use [] if nothing to include).
All other fields must be strings.

Respond with just the JSON:`;
}

// ---------- Public API ----------

/**
 * Synthesize contextual Lead fields using GPT-4o-mini.
 *
 * @param item            The raw Monday item
 * @param directlyMapped  Fields already extracted by the rule-based mapper
 * @param unmappedColumns Columns with text that didn't match any Lead field
 * @param openaiApiKey    OpenAI API key
 * @returns               Synthesized fields + token usage for cost tracking
 */
export async function synthesizeContextFields(
  item: MondayItem,
  directlyMapped: Record<string, unknown>,
  unmappedColumns: MondayColumnValue[],
  openaiApiKey: string
): Promise<{ fields: SynthesizedFields; usage: SynthesisUsage }> {
  const client = new OpenAI({ apiKey: openaiApiKey });

  const prompt = buildPrompt(
    item,
    directlyMapped,
    unmappedColumns,
    item.column_values
  );

  const zeroUsage: SynthesisUsage = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };

  let raw: string;
  let usage: SynthesisUsage;
  try {
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });
    raw = response.choices[0]?.message?.content ?? "{}";
    const u = response.usage;
    if (u) {
      usage = {
        inputTokens: u.prompt_tokens,
        outputTokens: u.completion_tokens,
        estimatedCostUsd: calcCost(u.prompt_tokens, u.completion_tokens),
      };
    } else {
      usage = zeroUsage;
    }
  } catch (err) {
    console.warn(`[synthesizer] OpenAI call failed: ${err instanceof Error ? err.message : err}`);
    return { fields: {}, usage: zeroUsage };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    console.warn(`[synthesizer] Failed to parse GPT JSON response:\n${raw}`);
    return { fields: {}, usage };
  }

  // Sanitize: only pass through recognized fields, drop anything extra.
  const result: SynthesizedFields = {};
  const allowed = new Set<string>(SYNTHESIZABLE_FIELDS);

  for (const [key, value] of Object.entries(parsed)) {
    if (!allowed.has(key) || value === null || value === undefined) continue;

    switch (key) {
      case "competitiveContext":
      case "excludeKeywords":
        if (Array.isArray(value)) {
          (result as Record<string, unknown>)[key] = value
            .filter((v): v is string => typeof v === "string")
            .map((s) => s.trim())
            .filter(Boolean);
        }
        break;
      default:
        if (typeof value === "string" && value.trim()) {
          (result as Record<string, unknown>)[key] = value.trim();
        }
    }
  }

  return { fields: result, usage };
}
