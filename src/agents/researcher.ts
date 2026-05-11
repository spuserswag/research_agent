/**
 * Agent 1 — Researcher
 *
 * Gathers a SourcePack on the prospect company using a layered tool strategy:
 *
 *   Phase 0 — Apollo enrichment (ALWAYS FIRST, when APOLLO_API_KEY is set):
 *     apollo_company_enrich  — firmographics: headcount, funding, tech stack
 *     apollo_people_search   — buying committee: C-suite + VP executives
 *
 *   Phase 1 — Perplexity breadth (sonar-pro, ~$0.01/call):
 *     perplexity_search — landscape overview, news, recent signals.
 *     Apollo covers static facts; Perplexity covers dynamic/real-time intel.
 *
 *   Phase 2 — Perplexity deep research (sonar-deep-research, ~$0.05–0.10/call):
 *     perplexity_discovery — targeted multi-step reasoning on confirmed angles.
 *     Skipped for angles already covered by Apollo.
 *
 *   Phase 3 — Firecrawl extraction (≤5 calls, ~$0.005/call):
 *     firecrawl_scrape — full-page markdown on highest-value URLs only.
 *
 * When APOLLO_API_KEY is absent, the Researcher skips Phase 0 and falls back
 * to Perplexity for firmographic and people data (higher cost, lower structure).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  type AgentResult,
  runAgentWithSchema,
} from "../lib/agentClient.js";
import {
  type Lead,
  type SourcePack,
  SourcePackSchema,
  SourceSchema,
} from "../types.js";

import { perplexityDiscoveryTool, perplexitySearchTool } from "../tools/perplexity.js";
import { firecrawlScrapeTool } from "../tools/firecrawl.js";
import { apolloCompanyEnrichTool, apolloPeopleSearchTool } from "../tools/apollo.js";
import { getConfig } from "../config.js";

const PROMPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../prompts/researcher.md",
);

const ResearcherOutputSchema = z.object({
  sources: z.array(SourceSchema).max(40),
});

// Cache prompt at first call — avoids repeated disk reads across test runs.
let _cachedPrompt: string | undefined;

export async function runResearcher(lead: Lead): Promise<AgentResult<SourcePack>> {
  const systemPrompt = (_cachedPrompt ??= await readFile(PROMPT_PATH, "utf8"));

  // Include Apollo tools only when the API key is configured. The prompt
  // checks the tool list and skips Phase 0 gracefully if they're absent.
  const apolloTools = getConfig().apolloApiKey
    ? [apolloCompanyEnrichTool, apolloPeopleSearchTool]
    : [];

  const { result, usage } = await runAgentWithSchema(
    {
      systemPrompt,
      userMessage: JSON.stringify(
        { lead, apolloAvailable: apolloTools.length > 0 },
        null,
        2,
      ),
      customTools: [
        ...apolloTools,
        perplexitySearchTool,
        perplexityDiscoveryTool,
        firecrawlScrapeTool,
      ],
      // Researcher does the heavy lifting — give it room for the full tool loop:
      // 2 Apollo calls + 1-4 Perplexity breadth + 2-3 deep + up to 5 firecrawl scrapes.
      maxTokens: 16000,
      maxIterations: 16,
    },
    ResearcherOutputSchema,
  );

  const sourcePack: SourcePack = SourcePackSchema.parse({
    sources: result.sources,
    lead,
    generatedAt: new Date().toISOString(),
  });

  return { result: sourcePack, usage };
}
