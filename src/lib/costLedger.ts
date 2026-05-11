/**
 * Cost Ledger — tracks API call costs across a single pipeline run.
 *
 * Each external API (Perplexity, Firecrawl) writes an entry here after
 * every call. The orchestrator reads the ledger at the end of the run
 * to print a cost breakdown and persist it to run.json.
 *
 * OpenAI costs are computed separately from the AgentUsage totals that
 * agentClient.ts already accumulates — no duplication needed.
 *
 * Pricing constants (USD per million tokens, or per call).
 * Verify at https://docs.perplexity.ai/guides/pricing and https://openai.com/pricing
 * before production use — these change periodically.
 *
 *   sonar-pro:           $1.00/M in,  $3.00/M out   (Perplexity, 2026-05)
 *   sonar-deep-research: $5.00/M in, $15.00/M out   (Perplexity, 2026-05)
 *   gpt-4o:              $2.50/M in, $10.00/M out   (OpenAI, 2026-05)
 *   gpt-4o-mini:         $0.15/M in,  $0.60/M out   (OpenAI, 2026-05)
 *   firecrawl:           $0.005 / scrape
 *   apollo/company_enrich: $0.01 / call (estimated; actual cost depends on Apollo plan tier)
 *   apollo/people_search:  $0.01 / call (estimated; actual cost depends on Apollo plan tier)
 *
 * Note on Apollo: Apollo.io is a subscription service — the true marginal
 * cost per call is often $0 within your plan limits. The $0.01 estimate
 * is a conservative accounting entry so run.json shows a cost line. Adjust
 * APOLLO_ESTIMATED_COST_USD_PER_CALL below to match your actual plan rate.
 */

// ---------- Pricing table ----------

interface TokenPricing { inputPerM: number; outputPerM: number; }
interface CallPricing  { perCall: number; }

const TOKEN_PRICING: Record<string, TokenPricing> = {
  "sonar-pro":           { inputPerM: 1.00,  outputPerM: 3.00  },
  "sonar-deep-research": { inputPerM: 5.00,  outputPerM: 15.00 },
  "gpt-4o":              { inputPerM: 2.50,  outputPerM: 10.00 },
  "gpt-4o-mini":         { inputPerM: 0.15,  outputPerM: 0.60  },
};

/** Adjust to match your Apollo plan's actual marginal per-call rate. */
const APOLLO_ESTIMATED_COST_USD_PER_CALL = 0.01;

const CALL_PRICING: Record<string, CallPricing> = {
  "firecrawl":            { perCall: 0.005 },
  "company_enrich":       { perCall: APOLLO_ESTIMATED_COST_USD_PER_CALL },
  "people_search":        { perCall: APOLLO_ESTIMATED_COST_USD_PER_CALL },
};

// ---------- Types ----------

export interface TokenEntry {
  kind: "tokens";
  service: string;   // e.g. "perplexity"
  model: string;     // e.g. "sonar-deep-research"
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface CallEntry {
  kind: "call";
  service: string;   // e.g. "firecrawl"
  model: string;     // e.g. "scrape"
  costUsd: number;
}

export type LedgerEntry = TokenEntry | CallEntry;

export interface CostSummaryLine {
  label: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface CostSummary {
  lines: CostSummaryLine[];
  totalCostUsd: number;
}

// ---------- Singleton state ----------

let _entries: LedgerEntry[] = [];

// ---------- Public API ----------

/** Reset the ledger. Call once at the start of each orchestrator run. */
export function resetLedger(): void {
  _entries = [];
}

/**
 * Record a Perplexity (or other token-billed) API call.
 * `model` must match a key in TOKEN_PRICING.
 */
export function recordTokenCall(
  service: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): void {
  const pricing = TOKEN_PRICING[model];
  if (!pricing) {
    // eslint-disable-next-line no-console
    console.warn(`costLedger: no pricing entry for service="${service}" model="${model}" — cost recorded as $0`);
  }
  const costUsd = pricing
    ? (inputTokens / 1_000_000) * pricing.inputPerM +
      (outputTokens / 1_000_000) * pricing.outputPerM
    : 0;
  _entries.push({ kind: "tokens", service, model, inputTokens, outputTokens, costUsd });
}

/**
 * Record a per-call-billed API call (e.g. Firecrawl scrape).
 * `model` must match a key in CALL_PRICING.
 */
export function recordCallCost(service: string, model: string): void {
  const pricing = CALL_PRICING[model] ?? CALL_PRICING[service];
  if (!pricing) {
    // eslint-disable-next-line no-console
    console.warn(`costLedger: no pricing entry for service="${service}" model="${model}" — cost recorded as $0`);
  }
  const costUsd = pricing?.perCall ?? 0;
  _entries.push({ kind: "call", service, model, costUsd });
}

/** Return all raw entries (for run.json). */
export function getLedgerEntries(): LedgerEntry[] {
  return [..._entries];
}

/**
 * Compute a grouped cost summary, optionally including an OpenAI line
 * derived from the existing AgentUsage totals.
 */
export function getCostSummary(openaiUsage?: {
  inputTokens: number;
  outputTokens: number;
  /** Defaults to "gpt-4o" if omitted. Used for cost attribution in the summary line. */
  model?: string;
}): CostSummary {
  const groups = new Map<string, CostSummaryLine>();

  function key(service: string, model: string) {
    return `${service}/${model}`;
  }

  function upsert(label: string, k: string): CostSummaryLine {
    if (!groups.has(k)) {
      groups.set(k, { label, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    }
    return groups.get(k)!;
  }

  // OpenAI line (from existing usage tracking).
  if (openaiUsage) {
    const model = openaiUsage.model ?? "gpt-4o";
    const k = key("openai", model);
    const pricing = TOKEN_PRICING[model] ?? TOKEN_PRICING["gpt-4o"]!;
    const costUsd =
      (openaiUsage.inputTokens / 1_000_000) * pricing.inputPerM +
      (openaiUsage.outputTokens / 1_000_000) * pricing.outputPerM;
    const line = upsert(`OpenAI  ${model}`, k);
    line.calls++;
    line.inputTokens += openaiUsage.inputTokens;
    line.outputTokens += openaiUsage.outputTokens;
    line.costUsd += costUsd;
  }

  // Ledger entries.
  for (const entry of _entries) {
    if (entry.kind === "tokens") {
      const k = key(entry.service, entry.model);
      const label = `${capitalize(entry.service)}  ${entry.model}`;
      const line = upsert(label, k);
      line.calls++;
      line.inputTokens += entry.inputTokens;
      line.outputTokens += entry.outputTokens;
      line.costUsd += entry.costUsd;
    } else {
      const k = key(entry.service, entry.model);
      const label = `${capitalize(entry.service)}  ${entry.model}`;
      const line = upsert(label, k);
      line.calls++;
      line.costUsd += entry.costUsd;
    }
  }

  const lines = [...groups.values()];
  const totalCostUsd = lines.reduce((s, l) => s + l.costUsd, 0);

  return { lines, totalCostUsd };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
