/**
 * CLI entry point.
 *
 * Run a single prep:
 *
 *   npm run prep -- --lead path/to/lead.json
 *
 * Or pass fields inline (lead.json takes precedence over flags):
 *
 *   npm run prep -- --company "Acme" \
 *                   --website https://acme.com \
 *                   --ae-name "Jordan" --ae-email jordan@arvayaconsulting.com \
 *                   --prospect-name "Pat Lee" --prospect-title "VP Data" \
 *                   --meeting-at 2026-05-12T15:00:00Z \
 *                   --product-focus "RAG implementation" \
 *                   --deal-stage warm
 *
 * Dry run (validate + preview without API calls):
 *
 *   npm run prep -- --lead path/to/lead.json --dry-run
 *
 * The orchestrator writes the brief plus all supporting research into
 * a per-prospect profile folder: ./profiles/<companySlug>/<runId>/.
 * The CLI prints the absolute path on success.
 */

import { readFile } from "node:fs/promises";
import { runOrchestrator } from "./orchestrator.js";
import { type Lead, LeadSchema } from "./types.js";

interface Flags {
  lead?: string;
  company?: string;
  website?: string;
  aeName?: string;
  aeEmail?: string;
  prospectName?: string;
  prospectTitle?: string;
  meetingAt?: string;
  productFocus?: string;
  dealStage?: string;
  prospectArchetype?: string;
  excludeKeywords?: string[];
  callObjective?: string;
  hypothesis?: string;
  meetingContext?: string;
  meetingType?: string;
  engagementShape?: string;
  introSource?: string;
  introContext?: string;
  competitiveContext?: string[];
  runId?: string;
  dryRun?: boolean;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));

  // 1. Load lead.json if provided.
  let leadFromFile: Partial<Lead> = {};
  if (flags.lead) {
    const raw = await readFile(flags.lead, "utf8");
    leadFromFile = JSON.parse(raw) as Partial<Lead>;
  }

  // 2. Merge file values with CLI flags. File wins.
  const merged: Partial<Lead> = {
    runId: flags.runId,
    company: flags.company,
    website: flags.website,
    aeName: flags.aeName,
    aeEmail: flags.aeEmail,
    prospectName: flags.prospectName,
    prospectTitle: flags.prospectTitle,
    meetingAt: flags.meetingAt,
    productFocus: flags.productFocus,
    dealStage: flags.dealStage as Lead["dealStage"] | undefined,
    prospectArchetype: flags.prospectArchetype as Lead["prospectArchetype"] | undefined,
    excludeKeywords: flags.excludeKeywords,
    callObjective: flags.callObjective,
    hypothesis: flags.hypothesis,
    meetingContext: flags.meetingContext,
    meetingType: flags.meetingType as Lead["meetingType"] | undefined,
    engagementShape: flags.engagementShape,
    introSource: flags.introSource as Lead["introSource"] | undefined,
    introContext: flags.introContext,
    competitiveContext: flags.competitiveContext,
    ...stripUndefined(leadFromFile),
  };

  // 3. Validate.
  const lead = LeadSchema.parse(merged);

  // 4. Dry-run: print a preview and exit without making any API calls.
  if (flags.dryRun) {
    dryRunPreview(lead);
    return;
  }

  // 5. Run.
  const result = await runOrchestrator(lead);

  // 6. Surface the profile folder so the AE can open it.
  // eslint-disable-next-line no-console
  console.log("");
  // eslint-disable-next-line no-console
  console.log(`Profile folder:  ${result.profilePath}`);
  // eslint-disable-next-line no-console
  console.log(`Brief:           ${result.briefPath}`);
  if (!result.verified.passedVerification) {
    // eslint-disable-next-line no-console
    console.log(
      "⚠️  Verifier flagged unsupported claims — see the warning at the bottom of the brief.",
    );
  }
}

// ---------- Dry-run preview ----------

function dryRunPreview(lead: Lead): void {
  const archetype = lead.prospectArchetype ?? "other";
  const archetypeNote: Record<string, string> = {
    aec_firm: "SAM.gov / USASpending / Procore-stack queries",
    aec_vendor: "Vendor-shape queries (case studies, ML hiring, GitHub, funding)",
    other: "General-purpose Perplexity flow",
  };

  /* eslint-disable no-console */
  console.log("\n🔍 Dry run — no API calls will be made.\n");
  console.log(`Company:          ${lead.company}`);
  if (lead.website) console.log(`Website:          ${lead.website}`);
  if (lead.prospectName) console.log(`Prospect:         ${lead.prospectName}${lead.prospectTitle ? ` (${lead.prospectTitle})` : ""}`);
  console.log(`AE:               ${lead.aeName} <${lead.aeEmail}>`);
  if (lead.meetingAt) console.log(`Meeting:          ${new Date(lead.meetingAt).toLocaleString()}`);
  console.log(`\nArchetype:        ${archetype}`);
  console.log(`Researcher mode:  ${archetypeNote[archetype] ?? "general"}`);
  if (lead.excludeKeywords?.length) {
    console.log(`Exclude keywords: ${lead.excludeKeywords.join(", ")}`);
  }
  if (lead.dealStage) console.log(`Deal stage:       ${lead.dealStage}`);
  if (lead.productFocus) console.log(`Product focus:    ${lead.productFocus}`);
  if (lead.meetingType) console.log(`Meeting type:     ${lead.meetingType}`);
  if (lead.callObjective) console.log(`\nCall objective:\n  ${lead.callObjective}`);
  if (lead.hypothesis) console.log(`\nHypothesis:\n  ${lead.hypothesis}`);
  if (lead.competitiveContext?.length) {
    console.log(`\nCompetitors:      ${lead.competitiveContext.join(", ")}`);
  }

  console.log("\n💰 Estimated cost (rough):");
  console.log("  Researcher (1-2 sonar-pro + 2-3 sonar-deep-research + ≤5 Firecrawl): ~$0.15–$0.40");
  console.log("  5 OpenAI gpt-4o agents:                                              ~$0.15–$0.40");
  console.log("  Total:                                                                ~$0.30–$0.80");
  console.log("\nRun without --dry-run to generate the brief.\n");
  /* eslint-enable no-console */
}

// ---------- Flag parser ----------

function parseFlags(argv: string[]): Flags {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok || !tok.startsWith("--")) continue;
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = "true";
    } else {
      out[key] = next;
      i++;
    }
  }
  // Map kebab-case CLI flags to camelCase keys.
  return {
    lead: out["lead"],
    company: out["company"],
    website: out["website"],
    aeName: out["ae-name"],
    aeEmail: out["ae-email"],
    prospectName: out["prospect-name"],
    prospectTitle: out["prospect-title"],
    meetingAt: out["meeting-at"],
    productFocus: out["product-focus"],
    dealStage: out["deal-stage"],
    prospectArchetype: out["prospect-archetype"],
    // --exclude-keywords accepts comma-separated values, e.g.
    //   --exclude-keywords "joist app,consumer contractor"
    excludeKeywords: out["exclude-keywords"]
      ? out["exclude-keywords"]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
    callObjective: out["call-objective"],
    hypothesis: out["hypothesis"],
    meetingContext: out["meeting-context"],
    meetingType: out["meeting-type"],
    engagementShape: out["engagement-shape"],
    introSource: out["intro-source"],
    introContext: out["intro-context"],
    // --competitive-context accepts comma-separated values
    competitiveContext: out["competitive-context"]
      ? out["competitive-context"]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
    runId: out["run-id"],
    dryRun: out["dry-run"] === "true",
  };
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
