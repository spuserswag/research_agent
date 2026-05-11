/**
 * Firecrawl — fetch a single URL and return clean markdown.
 *
 * Uses the v2 API via SDK v4.x: `Firecrawl.scrape(url, opts)` returns
 * a `Document` directly and throws on error (no `success`/`error`
 * wrapper anymore).
 *
 * The Researcher uses this only when Perplexity has surfaced a URL
 * that's clearly high-value and the search snippet alone is too thin:
 *   - executive interview transcripts
 *   - earnings call pages
 *   - long-form blog posts and engineering posts
 *   - press releases that are quoted but truncated in search snippets
 *
 * Each fetch costs Firecrawl credits. The hard cap is MAX_SCRAPES_PER_RUN
 * (default 5) — calls beyond this throw so the model cannot run up an
 * unbounded bill even if it ignores the prompt's advisory cap.
 *
 * Call `resetFirecrawlCap()` once at the start of each orchestrator run.
 */

import { z } from "zod";
import Firecrawl from "@mendable/firecrawl-js";
import { getConfig } from "../config.js";
import { recordCallCost } from "../lib/costLedger.js";

// ---------- Per-run cap ----------

const MAX_SCRAPES_PER_RUN = 5;
let _scrapeCount = 0;

/** Reset the per-run scrape counter. Call once at the start of each run. */
export function resetFirecrawlCap(): void {
  _scrapeCount = 0;
}

// ---------- Schema + types ----------

export const firecrawlScrapeInputSchema = z.object({
  url: z.string().url().describe("URL to fetch and convert to clean markdown."),
  format: z
    .enum(["markdown", "html"])
    .default("markdown")
    .describe("Output format. Default markdown — best for LLM consumption."),
  maxChars: z
    .number()
    .int()
    .min(1)
    .max(20000)
    .default(8000)
    .describe(
      "Cap on returned content length. The Researcher should pull a verbatim ≤600-char snippet from this for the SourcePack.",
    ),
});
export type FirecrawlScrapeInput = z.infer<typeof firecrawlScrapeInputSchema>;

export interface FirecrawlScrapeOutput {
  url: string;
  title?: string;
  content: string; // markdown or html, truncated to maxChars
  publishedAt?: string;
}

export const firecrawlScrapeTool = {
  name: "firecrawl_scrape",
  description:
    "Fetch a single URL and return its content as clean markdown. Use sparingly — only on URLs that Perplexity surfaced as clearly high-value (interviews, earnings transcripts, long blog posts). Hard limit: 5 calls per run.",
  inputSchema: firecrawlScrapeInputSchema,
  handler: firecrawlScrape,
} as const;

// ---------- Client ----------

let cachedClient: Firecrawl | undefined;

function client(): Firecrawl {
  if (!cachedClient) {
    cachedClient = new Firecrawl({ apiKey: getConfig().firecrawlApiKey });
  }
  return cachedClient;
}

// ---------- Handler ----------

export async function firecrawlScrape(
  input: FirecrawlScrapeInput,
): Promise<FirecrawlScrapeOutput> {
  // Enforce hard cap — prevents the model from ignoring the prompt's advisory.
  if (_scrapeCount >= MAX_SCRAPES_PER_RUN) {
    throw new Error(
      `firecrawl_scrape: hard cap of ${MAX_SCRAPES_PER_RUN} scrapes per run reached. ` +
        `Skipping ${input.url}. Use Perplexity snippets for remaining sources.`,
    );
  }
  _scrapeCount++;

  // v4 .scrape(url, options) returns a Document; throws on error.
  const doc = await client().scrape(input.url, {
    formats: [input.format],
    onlyMainContent: true,
  });

  // Record cost telemetry (~$0.005 per scrape).
  recordCallCost("firecrawl", "scrape");

  const raw =
    input.format === "markdown" ? doc.markdown ?? "" : doc.html ?? "";

  return {
    url: input.url,
    title: doc.metadata?.title,
    content: raw.slice(0, input.maxChars),
    publishedAt: doc.metadata?.publishedTime,
  };
}
