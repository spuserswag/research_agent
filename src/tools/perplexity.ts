/**
 * Perplexity Sonar — real-time prospect discovery tools.
 *
 * Two tools are exposed to the Researcher agent:
 *
 *   perplexity_search  — uses sonar-pro for fast, cheap breadth scanning.
 *                        ~$0.01/call. Use first to map the landscape.
 *
 *   perplexity_discovery — uses sonar-deep-research for targeted deep dives.
 *                          ~$0.05–0.10/call. Use only on angles confirmed
 *                          to have signal by the breadth scan.
 *
 * Pricing (2026): sonar-pro ~$1/M in, $3/M out.
 *                 sonar-deep-research ~$5/M in, $15/M out.
 *
 * API docs: https://docs.perplexity.ai/
 */

import { z } from "zod";
import { getConfig } from "../config.js";
import { recordTokenCall } from "../lib/costLedger.js";

const PERPLEXITY_BASE = "https://api.perplexity.ai";

// Matches the technical spec's input schema.
export const perplexityDiscoveryInputSchema = z.object({
  companyName: z
    .string()
    .describe("The prospect company to research."),
  executiveName: z
    .string()
    .optional()
    .describe("Specific executive to focus on, e.g. 'Jane Smith, CTO'. Narrows interview/quote searches."),
  targetDepartment: z
    .string()
    .optional()
    .describe("Department to focus on, e.g. 'Data & AI', 'Engineering'. Narrows job posting searches."),
  focus: z
    .array(z.enum(["news", "interviews", "job_postings", "financials", "people"]))
    .min(1)
    .describe(
      "Research angles to pursue. Use 'people' to discover the buying committee and key executives.",
    ),
  recency: z
    .enum(["day", "week", "month"])
    .default("month")
    .describe("Time window for results. 'month' is the right default for pre-call prep."),
});
export type PerplexityDiscoveryInput = z.infer<typeof perplexityDiscoveryInputSchema>;

export interface PerplexityDiscoveryCitation {
  /** 1-based index matching [N] markers in the answer text. */
  index: number;
  url: string;
}

export interface PerplexityDiscoveryOutput {
  /** Perplexity's synthesized answer with inline [N] citation markers. */
  answer: string;
  /** Ordered list of cited URLs. citations[0] corresponds to [1] in the answer. */
  citations: PerplexityDiscoveryCitation[];
}

export const perplexityDiscoveryTool = {
  name: "perplexity_discovery",
  description:
    "PRIMARY discovery tool. Identify high-value URLs and real-time signals (news, executive interviews, job postings, financials, team intelligence) for a prospect company. Uses multi-step web reasoning to surface dynamic intent signals that static databases miss. Returns a synthesized answer plus all cited URLs — use these URLs to decide what to deep-scrape with firecrawl_scrape.",
  inputSchema: perplexityDiscoveryInputSchema,
  handler: perplexityDiscovery,
} as const;

export async function perplexityDiscovery(
  input: PerplexityDiscoveryInput,
): Promise<PerplexityDiscoveryOutput> {
  const config = getConfig();
  const query = buildQuery(input);

  const body: PerplexityRequest = {
    model: "sonar-deep-research",
    messages: [{ role: "user", content: query }],
    search_recency_filter: input.recency,
    return_citations: true,
  };

  const res = await fetchWithRetry(`${PERPLEXITY_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.perplexityApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as PerplexityResponse;
  const answer = data.choices?.[0]?.message?.content ?? "";
  const rawCitations: string[] = data.citations ?? [];

  // Record cost telemetry.
  recordTokenCall(
    "perplexity",
    "sonar-deep-research",
    data.usage?.prompt_tokens ?? 0,
    data.usage?.completion_tokens ?? 0,
  );

  const citations: PerplexityDiscoveryCitation[] = rawCitations.map((url, i) => ({
    index: i + 1,
    url,
  }));

  return { answer, citations };
}

// ---------- Internal ----------

/**
 * Wraps `fetch` with exponential backoff for transient Perplexity errors.
 *
 * Retries on 429 (rate limit) and 5xx (server errors) up to MAX_RETRIES times,
 * waiting BACKOFF_MS * 2^attempt milliseconds between attempts.
 * Throws the final error if all retries are exhausted.
 */
const MAX_RETRIES = 3;
const BACKOFF_MS = 2000;

async function fetchWithRetry(
  url: string,
  init: RequestInit,
): Promise<Response> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = BACKOFF_MS * Math.pow(2, attempt - 1);
      // eslint-disable-next-line no-console
      console.warn(
        `Perplexity API: retry ${attempt}/${MAX_RETRIES} after ${delay}ms (previous error: ${lastError?.message ?? "unknown"})`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const res = await fetch(url, init);
    if (res.ok) return res;
    // Only retry on rate-limit and server errors; fail immediately on 4xx (except 429).
    if (res.status !== 429 && res.status < 500) {
      const errorText = await res.text();
      throw new Error(`Perplexity API error ${res.status}: ${errorText}`);
    }
    const errorText = await res.text();
    lastError = new Error(`Perplexity API error ${res.status}: ${errorText}`);
  }
  throw lastError ?? new Error("Perplexity API: unknown error after retries");
}

function buildQuery(input: PerplexityDiscoveryInput): string {
  const focusMap: Record<string, string> = {
    news: `the 5 most important recent news stories, press releases, or announcements`,
    interviews: `the 3 most recent executive interviews, keynote talks, podcasts, or conference panel appearances${input.executiveName ? ` featuring ${input.executiveName}` : " by company leadership"}`,
    job_postings: `the last 5 open job postings${input.targetDepartment ? ` in ${input.targetDepartment}` : " in AI, data engineering, or machine learning"} — include the job title, key responsibilities, and any technology or tool requirements mentioned`,
    financials: `the most recent earnings call transcript, investor report, Series funding announcement, or 10-K/10-Q filing detail`,
    people: `the current C-suite and VP-level executives${input.targetDepartment ? ` in ${input.targetDepartment}` : " in Data, AI, Engineering, and Technology"} — include name, title, LinkedIn URL if available, and when they joined the company`,
  };

  const focusSentences = input.focus.map((f) => `- ${focusMap[f]}`).join("\n");

  const recencyLabel =
    input.recency === "day" ? "24 hours" : input.recency === "week" ? "7 days" : "30 days";

  const parts = [
    `Research ${input.companyName} thoroughly and find:`,
    focusSentences,
    "",
    `For each item, include: the source URL, title, publication or posting date, and a 2–3 sentence summary of the most relevant content.`,
    `Prioritize content published within the last ${recencyLabel}.`,
    input.executiveName
      ? `Give special attention to content featuring or directly quoting ${input.executiveName}.`
      : "",
    input.targetDepartment
      ? `Focus on signals most relevant to the ${input.targetDepartment} organization.`
      : "",
    `Be specific: avoid generic company profiles or SEO listicles. Prefer primary sources (the company's own blog, official press releases, conference recordings, regulatory filings).`,
  ]
    .filter(Boolean)
    .join("\n");

  return parts;
}

// ---------- perplexity_search (sonar-pro — breadth) ----------

export const perplexitySearchInputSchema = z.object({
  query: z
    .string()
    .describe(
      "Free-form search query. Ask for a broad landscape overview — what kinds of content exist about this company across news, people, jobs, and financials.",
    ),
  recency: z
    .enum(["day", "week", "month"])
    .default("month")
    .describe("Time window for results."),
});
export type PerplexitySearchInput = z.infer<typeof perplexitySearchInputSchema>;

export const perplexitySearchTool = {
  name: "perplexity_search",
  description:
    "BREADTH SCAN tool. Use this FIRST, before perplexity_discovery. Makes a single fast sonar-pro call to map what kinds of content exist about the prospect (news articles, exec interviews, job postings, funding rounds, LinkedIn presence). Returns a synthesized overview plus cited URLs. Use the results to decide WHICH angles have enough signal to warrant a targeted perplexity_discovery deep dive.",
  inputSchema: perplexitySearchInputSchema,
  handler: perplexitySearch,
} as const;

export async function perplexitySearch(
  input: PerplexitySearchInput,
): Promise<PerplexityDiscoveryOutput> {
  const config = getConfig();

  const body: PerplexityRequest = {
    model: "sonar-pro",
    messages: [{ role: "user", content: input.query }],
    search_recency_filter: input.recency,
    return_citations: true,
  };

  const res = await fetchWithRetry(`${PERPLEXITY_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.perplexityApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as PerplexityResponse;
  const answer = data.choices?.[0]?.message?.content ?? "";
  const rawCitations: string[] = data.citations ?? [];

  // Record cost telemetry.
  recordTokenCall(
    "perplexity",
    "sonar-pro",
    data.usage?.prompt_tokens ?? 0,
    data.usage?.completion_tokens ?? 0,
  );

  const citations: PerplexityDiscoveryCitation[] = rawCitations.map((url, i) => ({
    index: i + 1,
    url,
  }));

  return { answer, citations };
}

interface PerplexityRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  search_recency_filter?: string;
  return_citations?: boolean;
}

interface PerplexityResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string;
    };
  }>;
  citations?: string[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}
