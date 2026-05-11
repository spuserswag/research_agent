/**
 * Shared types for the discovery prep pipeline.
 *
 * Every agent emits a strictly typed JSON payload. The orchestrator
 * validates the JSON against a Zod schema before passing it to the next
 * agent — no agent ever consumes another's free-form prose.
 *
 * Keep these definitions stable; the prompt files in src/prompts/*.md
 * reference these field names verbatim.
 */

import { z } from "zod";

// ---------- Lead (orchestrator input) ----------

/**
 * The orchestrator's input. Provided manually as JSON (CLI flag or file).
 *
 * `runId` identifies this prep run within the company profile folder
 * (`./profiles/<companySlug>/<runId>/`). If not supplied, the
 * orchestrator auto-generates one from a filesystem-safe ISO timestamp.
 */
export const LeadSchema = z.object({
  runId: z.string().optional(),
  company: z.string(),
  website: z.string().url().optional(),
  prospectName: z.string().optional(),
  prospectTitle: z.string().optional(),
  aeName: z.string(),
  aeEmail: z.string().email(),
  meetingAt: z.string().optional(), // ISO 8601
  /**
   * The Arvaya product/service being positioned on this call.
   * e.g. "RAG implementation", "AI readiness assessment", "LLM observability".
   * When set, the PersonalizationWriter frames Value Alignment Hooks against it.
   */
  productFocus: z.string().optional(),
  /**
   * Where this prospect sits in the pipeline.
   * cold      → discovery-first framing; no budget assumptions
   * warm      → prospect has engaged; hooks can be more specific
   * evaluation → actively comparing vendors; objection prep is critical
   */
  dealStage: z.enum(["cold", "warm", "evaluation"]).optional(),
  /**
   * What kind of company this is. Switches the Researcher's tool plan.
   * - aec_firm   → general contractor, design firm, or owner-operator.
   *                Researcher runs the SAM.gov / USASpending / Procore
   *                stack queries.
   * - aec_vendor → software/service vendor SELLING INTO AEC. Researcher
   *                runs the vendor-shape queries (case studies, ML/data
   *                hiring, GitHub, funding, founders) and SKIPS the
   *                gov-contract / project-stack queries.
   * - other      → general-purpose Perplexity flow.
   *
   * Defaults to `other` if omitted.
   */
  prospectArchetype: z.enum(["aec_firm", "aec_vendor", "other"]).optional(),
  /**
   * Disambiguation hints. The Researcher must drop any source whose URL,
   * title, or snippet contains any of these strings (case-insensitive).
   * Use for company names that collide with bigger entities, e.g. for
   * "Brantley Construction Company" set
   * `["Brantley County wildfire", "Brantley County, GA"]`; for "Joist AI"
   * set `["joist app", "consumer contractor"]`.
   */
  excludeKeywords: z.array(z.string()).optional(),

  // ----- Goal / context fields (see README "Optional but high-impact") -----

  /**
   * What Arvaya wants out of THIS specific meeting (not the deal as a
   * whole). One sentence. The Writer uses this verbatim as the brief's
   * `callObjective` instead of synthesizing one.
   *
   * Example: "Validate that Egnyte's structured-data-from-drawings gap
   * is real and severe enough to justify a 2-week discovery sprint."
   */
  callObjective: z.string().optional(),

  /**
   * Arvaya's prior on the prospect's biggest pain. The Researcher tests
   * it (validate or contradict); the SignalExtractor weights signals
   * that confirm or deny it; the Writer leads with it if confirmed and
   * soft-pivots if disconfirmed.
   *
   * Example: "Egnyte AI does file-level retrieval well but does not yet
   * extract structured data from AEC drawings. Their AEC customers are
   * asking for it. Their applied-ML org is thin so build-vs-partner is
   * live."
   */
  hypothesis: z.string().optional(),

  /**
   * Free-form narrative of how the meeting came about and what's at
   * stake. The Writer uses this to pick icebreaker register and frame
   * the tone of the brief. Multi-line is fine.
   */
  meetingContext: z.string().optional(),

  /**
   * What kind of meeting this is. Each value tunes the brief shape:
   * - first_intro       → exploratory, lots of discovery questions
   * - discovery         → deep-dive on confirmed pains; ROI hooks
   * - proposal_review   → walk through specifics; objection prep heavy
   * - renewal           → retention-framed; emphasize delivered value
   * - partnership_explore → joint-GTM framing rather than vendor sale
   */
  meetingType: z
    .enum([
      "first_intro",
      "discovery",
      "proposal_review",
      "renewal",
      "partnership_explore",
    ])
    .optional(),

  /**
   * What Arvaya is actually selling here. Tunes valueAlignmentHooks.
   * Free-form because Arvaya's offering shape varies. Examples:
   * "advisory retainer", "fixed-scope discovery sprint",
   * "implementation engagement", "training and enablement",
   * "staff augmentation".
   */
  engagementShape: z.string().optional(),

  /**
   * How this prospect entered the pipeline. Picks icebreaker register.
   */
  introSource: z
    .enum(["inbound", "referral", "event", "cold_outbound", "reactivation"])
    .optional(),

  /**
   * Free-form qualifier on `introSource`, e.g. "Met at AECTech 2026
   * booth" or "Referred by Pat Lee at Northwind Logistics".
   */
  introContext: z.string().optional(),

  /**
   * Likely competing vendors or service firms in this deal. Drives
   * Objection Predictions specifically. Example:
   * `["Slalom", "Accenture AI&Analytics", "in-house build"]`.
   */
  competitiveContext: z.array(z.string()).optional(),
});
export type Lead = z.infer<typeof LeadSchema>;

// ---------- Researcher output ----------

/**
 * One captured snippet. The `snippet` field is the verbatim excerpt
 * (from Perplexity citations or Firecrawl page text) that the Verifier
 * later cross-checks every claim against.
 *
 * `id` is opaque (e.g. "src-1"), assigned by the Researcher. All
 * downstream agents cite by id.
 */
export const SourceSchema = z.object({
  id: z.string(), // "src-1", "src-2", ...
  url: z.string().url(),
  title: z.string(),
  publishedAt: z.string().optional(), // ISO 8601 if known
  category: z.enum([
    "news",
    "exec_interview",
    "job_posting",
    "filing",
    "funding",
    "product",
    "social",
    "other",
  ]),
  snippet: z.string(), // verbatim, ≤ ~600 chars
});
export type Source = z.infer<typeof SourceSchema>;

export const SourcePackSchema = z.object({
  lead: LeadSchema,
  generatedAt: z.string(),
  sources: z.array(SourceSchema).max(40),
});
export type SourcePack = z.infer<typeof SourcePackSchema>;

// ---------- Signal Extractor output ----------

export const SignalSchema = z.object({
  kind: z.enum([
    "initiative",
    "pain",
    "tech_stack",
    "growth_indicator",
    "competitive_pressure",
    "regulatory_change",
  ]),
  summary: z.string(), // one sentence
  detail: z.string(), // 2–4 sentences
  supportingSourceIds: z.array(z.string()).min(1),
});
export type Signal = z.infer<typeof SignalSchema>;

export const SignalsSchema = z.object({
  signals: z.array(SignalSchema),
});
export type Signals = z.infer<typeof SignalsSchema>;

// ---------- Risk Detector output ----------

export const RiskSchema = z.object({
  category: z.enum([
    "layoffs",
    "budget_freeze",
    "leadership_churn",
    "security_incident",
    "legal_issue",
    "other",
  ]),
  severity: z.enum(["low", "medium", "high"]),
  summary: z.string(),
  detail: z.string(),
  /**
   * The verbatim snippet (or a contiguous slice of one) from the SourcePack
   * that triggered this risk flag. Forces the Risk Detector to ground each
   * risk in a real piece of source text rather than synthesizing one from
   * thin air. Must be present somewhere in one of the cited sources'
   * `snippet` fields — the QA verifier can spot-check.
   */
  evidenceQuote: z.string(),
  /**
   * One-paragraph chain-of-thought: WHY is this a risk in the current
   * (2026) market? What pattern in the snippet plus the wider operating
   * environment makes this concerning? Not a summary of the risk — a
   * justification for the severity assigned. Forcing this field surfaces
   * subtle patterns the agent would otherwise gloss past.
   */
  auditorReasoning: z.string(),
  supportingSourceIds: z.array(z.string()).min(1),
});
export type Risk = z.infer<typeof RiskSchema>;

export const RisksSchema = z.object({
  risks: z.array(RiskSchema),
});
export type Risks = z.infer<typeof RisksSchema>;

// ---------- Personalization Writer output ----------

/**
 * Every entry in the brief carries the source IDs that justify it.
 * The QAVerifier later fails the brief if a claim's source IDs do not
 * actually contain text supporting the claim.
 *
 * `label` is an optional short title for the item (e.g. "The Federal Win",
 * "Backlog & Capacity"). Rendered bold before the text.
 */
export const BriefItemSchema = z.object({
  label: z.string().optional(),
  text: z.string(),
  supportingSourceIds: z.array(z.string()),
});
export type BriefItem = z.infer<typeof BriefItemSchema>;

// ---------- Executive Snapshot ----------

/**
 * A data-point card shown at the top of the brief before icebreakers.
 * Each item is a key fact about the company: scale, backlog/capacity,
 * market context, or margin pressure — with a short bold label.
 */
export const SnapshotItemSchema = z.object({
  label: z.string().describe("Short label, e.g. 'Scale', 'Backlog & Capacity', 'Market Context', 'Margin Pressure'"),
  text: z.string().describe("1–2 sentences of specific data. Include numbers where available."),
  supportingSourceIds: z.array(z.string()),
});
export type SnapshotItem = z.infer<typeof SnapshotItemSchema>;

/**
 * One entry in the Attendee Intel section. Covers people likely to be
 * on the call or in the buying committee beyond the primary prospect.
 */
export const AttendeeIntelSchema = z.object({
  name: z.string(),
  title: z.string(),
  /** One sentence: tenure signal, recent hire status, or buying-committee role. */
  note: z.string(),
  /** Source IDs from the SourcePack that mention this person. May be empty. */
  supportingSourceIds: z.array(z.string()),
});
export type AttendeeIntel = z.infer<typeof AttendeeIntelSchema>;

// ---------- Government Contract ----------

export const GovContractSchema = z.object({
  agency: z.string().describe("Contracting agency or department, e.g. 'U.S. Army Corps of Engineers'"),
  description: z.string().describe("Project description — one sentence"),
  value: z.string().optional().describe("Contract value as a string, e.g. '$4.2M' or '$1.2M–$4.8M' if a range"),
  awardedAt: z.string().optional().describe("Award date, ISO 8601 or partial date like '2026-03'"),
  supportingSourceIds: z.array(z.string()),
});
export type GovContract = z.infer<typeof GovContractSchema>;

// ---------- Draft Brief ----------

export const DraftBriefSchema = z.object({
  /**
   * Data-point card shown above everything else.
   * 3–5 items covering scale, backlog/capacity, market context, margin pressure.
   */
  executiveSnapshot: z.array(SnapshotItemSchema).optional(),
  /**
   * 1–3 bullets summarising the most important signal, biggest risk, and
   * most likely objection. Designed for AEs who have 2 minutes, not 10.
   */
  tldr: z.array(z.string()).min(1).max(3),
  /**
   * One sentence: the single most important thing to learn on this call.
   * e.g. "Confirm whether the Q3 self-service analytics launch is funded
   * and who owns the vendor evaluation."
   */
  callObjective: z.string(),
  icebreakers: z.array(BriefItemSchema).min(2).max(5),
  valueAlignmentHooks: z.array(BriefItemSchema).min(2).max(5),
  potentialRedFlags: z.array(BriefItemSchema), // can be empty
  talkingPoints: z.array(BriefItemSchema).min(3).max(8),
  /**
   * People likely to be on the call or in the buying committee beyond
   * the primary prospect. Sourced from social/team signals.
   */
  attendeeIntel: z.array(AttendeeIntelSchema).max(4),
  objectionPredictions: z
    .array(
      z.object({
        objection: z.string(),
        suggestedResponse: z.string(),
        supportingSourceIds: z.array(z.string()),
      }),
    )
    .max(5),
  /**
   * Government and public-sector contract awards found for this company.
   * Populated when the prospect operates in construction, AEC, defense, or
   * other government-contracting sectors. Empty array if none found.
   */
  govContracts: z.array(GovContractSchema).optional(),
  /**
   * AEC / industry-specific prep notes for the AE.
   * Covers tech stack signals, active project pipeline, digital maturity,
   * labor signals, and any construction-specific context that doesn't fit
   * the other sections. Empty array if not applicable.
   */
  prepNotes: z.array(BriefItemSchema).optional(),
});
export type DraftBrief = z.infer<typeof DraftBriefSchema>;

// ---------- QA Verifier output ----------

export const VerificationNoteSchema = z.object({
  location: z.string(), // e.g. "icebreakers[1]"
  status: z.enum(["confirmed", "weak", "removed"]),
  reason: z.string(),
});
export type VerificationNote = z.infer<typeof VerificationNoteSchema>;

export const VerifiedBriefSchema = z.object({
  brief: DraftBriefSchema,
  notes: z.array(VerificationNoteSchema),
  passedVerification: z.boolean(),
});
export type VerifiedBrief = z.infer<typeof VerifiedBriefSchema>;

// ---------- Pipeline-level usage / cost telemetry ----------

/**
 * Per-stage usage record, mirrored in run.json. The orchestrator
 * accumulates each agent's `AgentUsage` (from agentClient) into this
 * shape so we can see which stages dominate cost over time.
 */
export interface StageUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  iterations: number;
}

export interface PipelineUsage {
  researcher: StageUsage;
  signalExtractor: StageUsage;
  riskDetector: StageUsage;
  personalizationWriter: StageUsage;
  qaVerifier: StageUsage;
  total: StageUsage;
}

// ---------- Delivery record ----------

export interface DeliveryRecord {
  attempted: boolean;
  delivered: boolean;
  to?: string;
  reason?: string;
  messageId?: string;
}

// ---------- Run record (written to <profileFolder>/run.json) ----------

export interface RunRecord {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  lead: Lead;
  sourcePack?: SourcePack;
  signals?: Signals;
  risks?: Risks;
  draft?: DraftBrief;
  verified?: VerifiedBrief;
  usage?: PipelineUsage;
  /** Per-service cost breakdown. Written by the orchestrator after all agents complete. */
  costs?: unknown;
  delivery?: DeliveryRecord;
  error?: string;
}
