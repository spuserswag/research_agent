/**
 * Centralized env loading + validation.
 *
 * Required keys fail loudly at startup. Email keys are optional —
 * if either RESEND_API_KEY or EMAIL_FROM is missing, the orchestrator
 * skips email delivery and notes the reason in the run record.
 */

import "dotenv/config";
import { z } from "zod";

const ConfigSchema = z.object({
  // Required — OpenAI Chat Completions API
  openaiApiKey: z.string().min(1),
  perplexityApiKey: z.string().min(1),
  firecrawlApiKey: z.string().min(1),
  // Optional — Apollo.io firmographic enrichment (company + people).
  // When set, the Researcher calls Apollo first for structured baseline data
  // (headcount, funding, tech stack, executives) before Perplexity, which
  // cuts sonar-deep-research calls and cost. Graceful degradation: if unset,
  // the Researcher skips Apollo and falls back to Perplexity for everything.
  apolloApiKey: z.string().optional(),

  // Where company profile folders are written.
  profilesDir: z.string().default("./profiles"),

  // Optional — email delivery via Resend.
  resendApiKey: z.string().optional(),
  emailFrom: z.string().email().optional(),
  emailReplyTo: z.string().email().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | undefined;

export function getConfig(): Config {
  if (cached) return cached;

  const parsed = ConfigSchema.safeParse({
    openaiApiKey: process.env.OPENAI_API_KEY,
    perplexityApiKey: process.env.PERPLEXITY_API_KEY,
    firecrawlApiKey: process.env.FIRECRAWL_API_KEY,
    profilesDir: process.env.PROFILES_DIR,
    apolloApiKey: process.env.APOLLO_API_KEY || undefined,
    resendApiKey: process.env.RESEND_API_KEY || undefined,
    emailFrom: process.env.EMAIL_FROM || undefined,
    emailReplyTo: process.env.EMAIL_REPLY_TO || undefined,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}
