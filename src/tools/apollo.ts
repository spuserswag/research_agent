/**
 * Apollo.io tools — structured firmographic enrichment.
 *
 * Apollo is the FIRST data source the Researcher calls on every run.
 * It returns fast, cheap, structured data (headcount, funding, tech stack,
 * executives) that Perplexity's deep-research model would spend $0.05–0.10
 * duplicating with lower accuracy. Apollo answers "what is this company"
 * so Perplexity can focus on "what is happening right now".
 *
 * Decision framework (enforced in the Researcher prompt):
 *
 *   Apollo ──────► static / structured / enumerable data
 *     • Headcount, industry, location, founded year
 *     • Total funding, latest round type + date
 *     • Tech stack fingerprint
 *     • Named executives (C-suite, VP-level)
 *
 *   Perplexity ──► dynamic / real-time / narrative data
 *     • News in the last 30 days
 *     • Executive interviews and quotes
 *     • Open job postings
 *     • Competitor moves, strategic pivots
 *     • Anything Apollo returned no data for (fallback)
 *
 * Endpoints used:
 *   Company enrich:  GET  https://api.apollo.io/api/v1/organizations/enrich
 *   People search:   POST https://api.apollo.io/api/v1/mixed_people/search
 *
 * Auth: X-Api-Key header (the Apollo API key from config).
 *
 * Pricing: Apollo is a subscription service; per-call cost is tracked
 * in costLedger at the APOLLO_CALL_COST_USD estimate so run.json keeps
 * a consistent cost line even if the true marginal cost is $0 on your plan.
 */

import { z } from "zod";
import type { CustomTool } from "../lib/agentClient.js";
import { getConfig } from "../config.js";
import { recordCallCost } from "../lib/costLedger.js";

// ---- Apollo API base URL ----

const APOLLO_BASE = "https://api.apollo.io/api/v1";

// ---- Shared fetch helper ----

async function apolloFetch(
  path: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
): Promise<unknown> {
  const config = getConfig();
  if (!config.apolloApiKey) {
    throw new Error("Apollo API key not configured (APOLLO_API_KEY env var).");
  }

  const url = `${APOLLO_BASE}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Api-Key": config.apolloApiKey,
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Apollo API error ${res.status}: ${text}`);
  }

  return res.json();
}

// ---- Company Enrich ----

/**
 * Raw Apollo organization response (partial — we only map what's useful).
 */
interface ApolloOrganization {
  name?: string;
  website_url?: string;
  primary_domain?: string;
  estimated_num_employees?: number;
  industry?: string;
  short_description?: string;
  founded_year?: number;
  city?: string;
  state?: string;
  country?: string;
  total_funding?: number;
  total_funding_printed?: string;
  latest_funding_stage?: string;
  latest_funding_round_date?: string;
  technologies?: Array<{ name: string; category?: string }>;
  linkedin_uid?: string;
  linkedin_url?: string;
}

interface ApolloEnrichResponse {
  organization?: ApolloOrganization;
}

export interface ApolloCompanyData {
  name: string | null;
  domain: string | null;
  estimatedEmployees: number | null;
  industry: string | null;
  description: string | null;
  foundedYear: number | null;
  location: string | null;
  totalFundingUsd: number | null;
  totalFundingFormatted: string | null;
  latestFundingStage: string | null;
  latestFundingDate: string | null;
  techStack: string[];
  linkedinUrl: string | null;
}

async function apolloCompanyEnrich(domain: string): Promise<ApolloCompanyData> {
  recordCallCost("apollo", "company_enrich");

  const raw = (await apolloFetch(
    `/organizations/enrich?domain=${encodeURIComponent(domain)}`,
    "GET",
  )) as ApolloEnrichResponse;

  const org = raw.organization ?? {};

  const location = [org.city, org.state, org.country]
    .filter(Boolean)
    .join(", ") || null;

  const techStack = (org.technologies ?? []).map((t) => t.name).filter(Boolean);

  return {
    name: org.name ?? null,
    domain: org.primary_domain ?? org.website_url ?? null,
    estimatedEmployees: org.estimated_num_employees ?? null,
    industry: org.industry ?? null,
    description: org.short_description ?? null,
    foundedYear: org.founded_year ?? null,
    location,
    totalFundingUsd: org.total_funding ?? null,
    totalFundingFormatted: org.total_funding_printed ?? null,
    latestFundingStage: org.latest_funding_stage ?? null,
    latestFundingDate: org.latest_funding_round_date ?? null,
    techStack,
    linkedinUrl: org.linkedin_url ?? null,
  };
}

// ---- People Search ----

interface ApolloPerson {
  first_name?: string;
  last_name?: string;
  name?: string;
  title?: string;
  headline?: string;
  linkedin_url?: string;
  email?: string;
  email_status?: string;
  city?: string;
  state?: string;
  country?: string;
  employment_history?: Array<{
    organization_name?: string;
    title?: string;
    start_date?: string;
    end_date?: string;
    current?: boolean;
  }>;
}

interface ApolloPeopleResponse {
  people?: ApolloPerson[];
  pagination?: { total_entries?: number };
}

export interface ApolloPersonData {
  name: string | null;
  title: string | null;
  headline: string | null;
  linkedinUrl: string | null;
  email: string | null;
  emailStatus: string | null;
  location: string | null;
  currentTenureStartDate: string | null;
}

async function apolloPeopleSearch(
  domain: string,
  titleKeywords?: string[],
  perPage = 10,
): Promise<ApolloPersonData[]> {
  recordCallCost("apollo", "people_search");

  const body: Record<string, unknown> = {
    q_organization_domains: domain,
    per_page: Math.min(perPage, 25), // Apollo max is 25 per page on free/basic
    page: 1,
  };

  if (titleKeywords && titleKeywords.length > 0) {
    // Apollo uses person_titles as an array of exact-ish matches.
    body.person_titles = titleKeywords;
  } else {
    // Default: senior leadership sweep.
    body.person_titles = [
      "CEO",
      "Chief Executive Officer",
      "COO",
      "CTO",
      "Chief Technology Officer",
      "CPO",
      "Chief Product Officer",
      "CFO",
      "Chief Financial Officer",
      "VP Engineering",
      "VP Product",
      "VP Sales",
      "Head of Engineering",
      "Head of Product",
      "Head of AI",
      "Head of Data",
      "Founder",
      "Co-Founder",
      "President",
      "General Manager",
    ];
  }

  const raw = (await apolloFetch("/mixed_people/search", "POST", body)) as ApolloPeopleResponse;
  const people = raw.people ?? [];

  return people.map((p): ApolloPersonData => {
    const location = [p.city, p.state, p.country].filter(Boolean).join(", ") || null;

    const currentRole = (p.employment_history ?? []).find((h) => h.current);
    const tenureStart = currentRole?.start_date ?? null;

    return {
      name: p.name ?? ([p.first_name, p.last_name].filter(Boolean).join(" ") || null),
      title: p.title ?? null,
      headline: p.headline ?? null,
      linkedinUrl: p.linkedin_url ?? null,
      email: p.email ?? null,
      emailStatus: p.email_status ?? null,
      location,
      currentTenureStartDate: tenureStart,
    };
  });
}

// ---- CustomTool wrappers for the agent ----

const CompanyEnrichInputSchema = z.object({
  domain: z.string().describe(
    "The company's primary website domain, e.g. 'egnyte.com' or 'joist.ai'. Do not include https:// or www.",
  ),
});

export const apolloCompanyEnrichTool: CustomTool<
  z.infer<typeof CompanyEnrichInputSchema>,
  ApolloCompanyData
> = {
  name: "apollo_company_enrich",
  description:
    "Enrich a company using Apollo.io's organization database. Returns headcount, industry, " +
    "location, founded year, total funding, latest funding round, tech stack (SaaS tools fingerprint), " +
    "and LinkedIn URL. Call this FIRST on every run — it is fast (~1s), cheap, and provides the " +
    "structured firmographic baseline that prevents Perplexity from wasting deep-research credits " +
    "on data that is already available in a structured form. If the company domain is unknown, " +
    "infer it from lead.website.",
  inputSchema: CompanyEnrichInputSchema,
  handler: ({ domain }) => apolloCompanyEnrich(domain),
};

const PeopleSearchInputSchema = z.object({
  domain: z.string().describe(
    "Company domain to search within, e.g. 'egnyte.com'. Do not include protocol or www.",
  ),
  titleKeywords: z
    .array(z.string())
    .optional()
    .describe(
      "Optional list of job title keywords to filter by, e.g. ['Head of AI', 'VP Engineering']. " +
      "If omitted, defaults to a C-suite + VP + Founder sweep.",
    ),
  perPage: z
    .number()
    .int()
    .min(1)
    .max(25)
    .optional()
    .describe("Number of results to return (1–25). Default 10."),
});

export const apolloPeopleSearchTool: CustomTool<
  z.infer<typeof PeopleSearchInputSchema>,
  ApolloPersonData[]
> = {
  name: "apollo_people_search",
  description:
    "Search Apollo.io for people at a company by domain. Returns name, title, LinkedIn URL, " +
    "email (when available), location, and tenure start date. " +
    "Call this immediately after apollo_company_enrich to build the buying committee and " +
    "attendee intel before Perplexity. Apollo's people data is structured and reliable for " +
    "C-suite/VP-level executives. Use Perplexity only for recent hires or executives Apollo " +
    "does not surface (e.g. those with very new tenures or minimal LinkedIn presence).",
  inputSchema: PeopleSearchInputSchema,
  handler: ({ domain, titleKeywords, perPage }) =>
    apolloPeopleSearch(domain, titleKeywords, perPage),
};
