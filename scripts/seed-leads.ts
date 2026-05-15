/**
 * Seed `leads/*.json` from `companies.csv`.
 *
 * Reads the AECTech 2026 exhibitor list, infers reasonable defaults
 * (archetype, exclude keywords, website), and writes one lead.json per
 * company into `./leads/`. NEVER clobbers an existing lead file — so
 * the hand-tuned ones (egnyte, joist-ai, seev, Larson-Design-Group)
 * are safe.
 *
 *   npm run seed:leads
 *
 * Output:
 *   leads/<slug>.json   one per exhibitor in companies.csv
 *   (existing files untouched, marked as "skipped" in the summary)
 */

import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CSV_PATH = path.join(ROOT, "companies.csv");
const LEADS_DIR = path.join(ROOT, "leads");

interface CsvRow {
  exhibitor: string;
  sponsorLevel: string;
  description: string;
}

// ---- CSV parser (handles quoted fields with embedded commas) ----
function parseCsv(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  // Skip header.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const fields = splitCsvLine(line);
    if (fields.length < 3) continue;
    rows.push({
      exhibitor: fields[0]!,
      sponsorLevel: fields[1]!,
      description: fields[2]!,
    });
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

// ---- Slug + website inference ----
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\//g, "-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60) || "unknown";
}

/**
 * Domain inference is best-effort. We pick a plausible domain stem and
 * default to .com — the Researcher's Phase -1 disambiguation step
 * tolerates a wrong/missing domain (it just falls back to the company
 * phrase). Hand-edit any that matter before generating a brief.
 */
function inferWebsite(name: string): string {
  const stem = name
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/,.*/, "")           // "aec+tech, AI in AEC..." → "aec+tech"
    .replace(/\s+(inc|llc|corp|co|ltd|technologies|tech)\.?$/i, "")
    .replace(/[^a-z0-9]+/g, "");
  return `https://www.${stem}.com`;
}

// ---- Hand-tuned overrides for known collision-prone or
//      archetype-ambiguous entries. ----
//
// The seeder picks safe defaults; these overrides only sharpen what
// would otherwise produce a worse brief.
const OVERRIDES: Record<string, Partial<LeadShape>> = {
  "Box": {
    excludeKeywords: ["box office", "cardboard", "boxing", "boxxer"],
    website: "https://www.box.com",
  },
  "Joist AI": {
    excludeKeywords: ["joist app", "consumer contractor", "homeowner"],
    website: "https://www.joist.ai",
  },
  "Mosaic": {
    excludeKeywords: ["The Mosaic Company", "NYSE:MOS", "fertilizer", "potash"],
    website: "https://www.mosaicapp.com",
  },
  "IES": {
    excludeKeywords: ["IES Holdings", "IES Engineering Services", "Brunswick"],
    website: "https://www.iesve.com",
  },
  "Kinship": {
    excludeKeywords: ["Kinship Care", "Kinship adoption", "pet insurance"],
  },
  "Seev": {
    excludeKeywords: ["Seev cosmetics", "seev.fr"],
  },
  "Nomic": {
    excludeKeywords: ["Nomic Bio", "Nomic Foundation", "Atlas embedding"],
    website: "https://www.nomic.com",
  },
  "/slantis": {
    excludeKeywords: ["Atlantis"],
    website: "https://www.slantis.com",
  },
  "Unanet": {
    website: "https://www.unanet.com",
  },
  "Deltek": {
    website: "https://www.deltek.com",
  },
  "Egnyte": {
    website: "https://www.egnyte.com",
  },
  "aec+tech, AI in AEC and Neostack": {
    // Multi-org row — pick the most likely target. Worth a manual edit.
    website: "https://www.neostack.com",
    excludeKeywords: ["NEOSTACK Inc", "NEOSTACK pty"],
  },
};

// ---- Lead shape (subset — full schema is in src/types.ts) ----
interface LeadShape {
  company: string;
  website?: string;
  prospectName?: string;
  prospectTitle?: string;
  aeName: string;
  aeEmail: string;
  meetingAt?: string;
  productFocus?: string;
  dealStage?: string;
  prospectArchetype?: string;
  excludeKeywords?: string[];
  engagementShape?: string;
  meetingType?: string;
  introSource?: string;
  introContext?: string;
  callObjective?: string;
  hypothesis?: string;
  meetingContext?: string;
  competitiveContext?: string[];
  /** Free-form context block — uses the company description from companies.csv. */
  description?: string;
}

function buildLead(row: CsvRow): LeadShape {
  const override = OVERRIDES[row.exhibitor] || {};
  const lead: LeadShape = {
    company: row.exhibitor,
    website: override.website ?? inferWebsite(row.exhibitor),
    prospectName: "",
    prospectTitle: "Founder or Head of Product",
    aeName: "Ryan",
    aeEmail: "ryan@arvayaconsulting.com",
    dealStage: "cold",
    prospectArchetype: "aec_vendor", // ALL 40 are AEC-vendors per companies.csv source
    excludeKeywords: override.excludeKeywords ?? [],
    productFocus: "AI consulting and implementation",
    engagementShape: "fixed-scope discovery sprint (2 weeks), with optional implementation phase",
    meetingType: "first_intro",
    introSource: "event",
    introContext: "AECTech 2026 — sponsor or exhibitor; first conversation.",
    callObjective: `Identify one concrete pain in ${row.exhibitor}'s AI / data roadmap that Arvaya can credibly accelerate, then decide whether a 2-week discovery sprint is worth proposing.`,
    hypothesis: `${row.exhibitor} has shipped its core product but is now under pressure to add AI-native capabilities. The applied-ML / data org is likely thin relative to the roadmap, so build-vs-partner is live.`,
    meetingContext: `First conversation. ${row.exhibitor} is on the AECTech 2026 exhibitor list. Use the brief to find a credible wedge before the meeting.`,
    competitiveContext: ["Slalom", "Accenture AI&Analytics", "in-house build (their default)"],
    description: row.description,
  };
  // Apply other overrides (sponsorship, etc.)
  return { ...lead, ...override, company: row.exhibitor };
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function main(): Promise<void> {
  const csv = await readFile(CSV_PATH, "utf8");
  const rows = parseCsv(csv);

  await mkdir(LEADS_DIR, { recursive: true });

  let written = 0;
  let skipped = 0;

  for (const row of rows) {
    const slug = slugify(row.exhibitor);
    const dest = path.join(LEADS_DIR, `${slug}.json`);
    if (await exists(dest)) {
      // eslint-disable-next-line no-console
      console.log(`  ⊙ skip   ${slug}.json (already exists)`);
      skipped++;
      continue;
    }
    const lead = buildLead(row);
    await writeFile(dest, JSON.stringify(lead, null, 2) + "\n", "utf8");
    // eslint-disable-next-line no-console
    console.log(`  ✓ wrote  ${slug}.json`);
    written++;
  }

  // eslint-disable-next-line no-console
  console.log(`\nDone. ${written} written, ${skipped} skipped (${rows.length} rows in CSV).`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
