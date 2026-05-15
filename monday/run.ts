/**
 * monday/run.ts — CLI entry point
 *
 * Fetch one item or a full board from Monday.com and produce Lead JSON files.
 *
 * Usage:
 *
 *   # Fetch a single item (deal) by Monday item ID
 *   npx tsx monday/run.ts --item 1234567890
 *
 *   # Fetch all items on a board
 *   npx tsx monday/run.ts --board 9876543210
 *
 *   # Enable AI synthesis of contextual fields (hypothesis, callObjective, etc.)
 *   npx tsx monday/run.ts --board 9876543210 --ai
 *
 *   # Just print the board's column schema (to help fill in mapping.json)
 *   npx tsx monday/run.ts --board 9876543210 --inspect-columns
 *
 *   # Write lead JSON files to a custom folder (default: monday/out/)
 *   npx tsx monday/run.ts --board 9876543210 --output ./leads
 *
 *   # Preview without writing files (still writes a run log)
 *   npx tsx monday/run.ts --item 1234567890 --dry-run
 *
 * Required env vars (.env):
 *   MONDAY_API_KEY   — Monday.com personal API token
 *   OPENAI_API_KEY   — only needed when --ai is passed
 *
 * Every run writes a structured log to monday/log/<timestamp>.json
 * so you can track extraction quality improvements over time.
 */

import "dotenv/config";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { LeadSchema } from "../src/types.js";
import type { Lead } from "../src/types.js";
import { fetchBoard, fetchItem, fetchBoardColumns } from "./client.js";
import { mapItemToLead, describeMappingResult } from "./mapper.js";
import { synthesizeContextFields } from "./synthesizer.js";
import type { SynthesisUsage } from "./synthesizer.js";
import type { MondayItem, ColumnMapping, MondayColumnValue } from "./types.js";

// Absolute path to the monday/ folder (works regardless of cwd).
const MONDAY_DIR = path.dirname(new URL(import.meta.url).pathname);
const LOG_DIR    = path.join(MONDAY_DIR, "log");

// ---------- Types ----------

interface Flags {
  item?: string;
  board?: string;
  output: string;
  ai: boolean;
  dryRun: boolean;
  inspectColumns: boolean;
  verbose: boolean;
}

/** Everything we capture per item for the run log. */
interface ItemLogEntry {
  mondayId: string;
  name: string;
  slug: string;
  passed: boolean;
  /** Zod validation errors, if any */
  zodIssues: string[];
  /** The Lead fields we successfully extracted (field → value) */
  extractedFields: Record<string, unknown>;
  /** Columns matched to a Lead field (column title → Lead field name) */
  columnMappings: Record<string, string>;
  /** Column titles that had data but weren't matched to any Lead field */
  unmappedColumnTitles: string[];
  /** Column titles that had data but extracted an empty/undefined value
   *  (matched but produced nothing — useful for spotting normalizer gaps) */
  matchedButEmpty: string[];
  /** Whether AI synthesis ran for this item */
  aiSynthesized: boolean;
  /** Fields added by AI synthesis */
  synthesizedFields: string[];
  /** Lead JSON file written (undefined on dry-run) */
  outputFile?: string;
}

/** Top-level run log written to monday/log/<timestamp>.json */
interface RunLog {
  runAt: string;          // ISO 8601
  boardId?: string;
  itemId?: string;
  flags: Omit<Flags, "output"> & { output: string };
  mappingFile: string;    // path to mapping.json used
  summary: {
    total: number;
    passed: number;
    warned: number;
    fieldsExtractedAvg: number;   // average # of Lead fields per item
    topUnmappedColumns: string[]; // columns most often unmapped across all items
  };
  items: ItemLogEntry[];
}

// ---------- Flag parser ----------

function parseFlags(argv: string[]): Flags {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok?.startsWith("--")) continue;
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = "true";
    } else {
      out[key] = next;
      i++;
    }
  }
  return {
    item: out["item"],
    board: out["board"],
    output: out["output"] ?? path.join(MONDAY_DIR, "out"),
    ai: out["ai"] === "true",
    dryRun: out["dry-run"] === "true",
    inspectColumns: out["inspect-columns"] === "true",
    verbose: out["verbose"] === "true",
  };
}

// ---------- Load mapping.json ----------

async function loadMapping(): Promise<ColumnMapping | undefined> {
  const mappingPath = path.join(MONDAY_DIR, "mapping.json");
  if (!existsSync(mappingPath)) return undefined;
  try {
    const raw = await readFile(mappingPath, "utf8");
    const parsed = JSON.parse(raw) as ColumnMapping & { _readme?: string };
    delete (parsed as unknown as Record<string, unknown>)["_readme"];
    // Strip empty-string values — they fall through to auto-detection
    if (parsed.columnMap) {
      for (const [k, v] of Object.entries(parsed.columnMap)) {
        if (!v) delete parsed.columnMap[k];
      }
    }
    return parsed;
  } catch {
    console.warn("⚠️  Could not parse monday/mapping.json — falling back to auto-detection.");
    return undefined;
  }
}

// ---------- Process one item → Lead ----------

interface ProcessResult {
  lead: Partial<Lead>;
  slug: string;
  passed: boolean;
  issues: string[];
  columnMappings: Record<string, string>;
  unmappedColumns: MondayColumnValue[];
  matchedButEmptyTitles: string[];
  aiSynthesized: boolean;
  synthesizedFields: string[];
  synthUsage?: SynthesisUsage;
}

async function processItem(
  item: MondayItem,
  mapping: ColumnMapping | undefined,
  flags: Flags,
  openaiApiKey: string | undefined
): Promise<ProcessResult> {
  // 1. Rule-based mapping
  const mapped = mapItemToLead(item, mapping);

  if (flags.verbose) {
    console.log(describeMappingResult(item, mapped));
  }

  // Track columns that matched a field but produced an empty/undefined value.
  // This catches genuine normalizer gaps (e.g. a new Status label we haven't mapped).
  // Known sentinel values ("TBD", "N/A", etc.) are intentionally skipped by the
  // normalizers — they are NOT gaps, so we exclude them from this diagnostic.
  const SENTINEL_VALUES = /^(tbd|n\/a|na|none|-)$/i;

  const matchedButEmptyTitles: string[] = [];
  for (const col of item.column_values) {
    if (!mapped.consumedColumnTitles.has(col.title)) continue;
    const targetField = mapped.columnFieldMap.get(col.title);
    if (!targetField) continue;
    const text = col.text?.trim() ?? "";
    if (text && !SENTINEL_VALUES.test(text) && !(targetField in mapped.fields)) {
      matchedButEmptyTitles.push(`${col.title} (→${targetField}, raw="${text}")`);
    }
  }

  let fields = { ...mapped.fields };
  let aiSynthesized = false;
  const synthesizedFields: string[] = [];
  let synthUsage: SynthesisUsage | undefined;

  // 2. AI synthesis (if enabled)
  if (flags.ai) {
    if (!openaiApiKey) {
      console.warn("  ⚠️  --ai flag set but OPENAI_API_KEY is not in .env — skipping synthesis.");
    } else {
      process.stdout.write("  🤖  Running AI synthesis...");
      const { fields: synthesized, usage } = await synthesizeContextFields(
        item,
        fields,
        mapped.unmappedColumns,
        openaiApiKey
      );
      synthUsage = usage;
      for (const [k, v] of Object.entries(synthesized)) {
        if (v !== undefined && !(k in fields)) {
          fields[k] = v;
          synthesizedFields.push(k);
        }
      }
      aiSynthesized = true;
      const n = synthesizedFields.length;
      const costStr = usage.estimatedCostUsd > 0
        ? ` ($${usage.estimatedCostUsd.toFixed(4)})`
        : "";
      process.stdout.write(` synthesized ${n} field${n !== 1 ? "s" : ""}${costStr}\n`);
      if (flags.verbose && n > 0) {
        console.log("  Synthesized:", JSON.stringify(synthesized, null, 2));
      }
    }
  }

  // 3. Zod validation
  const result = LeadSchema.safeParse(fields);
  const issues: string[] = [];
  if (!result.success) {
    for (const issue of result.error.issues) {
      issues.push(`${issue.path.join(".") || "root"}: ${issue.message}`);
    }
  }

  // Slug for the output filename
  const company = (fields["company"] as string | undefined) ?? item.name ?? "unknown";
  const slug = company
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);

  // Serialize columnFieldMap for logging
  const columnMappings: Record<string, string> = {};
  for (const [title, field] of mapped.columnFieldMap.entries()) {
    columnMappings[title] = field;
  }

  return {
    lead: fields as Partial<Lead>,
    slug,
    passed: result.success,
    issues,
    columnMappings,
    unmappedColumns: mapped.unmappedColumns,
    matchedButEmptyTitles,
    aiSynthesized,
    synthesizedFields,
    synthUsage,
  };
}

// ---------- Write files ----------

async function writeLeadFile(outputDir: string, slug: string, lead: Partial<Lead>): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const filepath = path.join(outputDir, `${slug}.json`);
  await writeFile(filepath, JSON.stringify(lead, null, 2), "utf8");
  return filepath;
}

// ---------- Run log ----------

function buildRunLog(
  flags: Flags,
  mapping: ColumnMapping | undefined,
  boardId: string | undefined,
  results: Array<{ item: MondayItem } & ProcessResult & { outputFile?: string }>
): RunLog {
  const itemLogs: ItemLogEntry[] = results.map((r) => ({
    mondayId: r.item.id,
    name: r.item.name,
    slug: r.slug,
    passed: r.passed,
    zodIssues: r.issues,
    extractedFields: r.lead as Record<string, unknown>,
    columnMappings: r.columnMappings,
    unmappedColumnTitles: r.unmappedColumns.map((c) => `${c.title}: "${c.text?.slice(0, 80)}"`),
    matchedButEmpty: r.matchedButEmptyTitles,
    aiSynthesized: r.aiSynthesized,
    synthesizedFields: r.synthesizedFields,
    outputFile: r.outputFile,
  }));

  // Tally the most-frequently unmapped columns across all items
  const unmappedCounts = new Map<string, number>();
  for (const r of results) {
    for (const col of r.unmappedColumns) {
      unmappedCounts.set(col.title, (unmappedCounts.get(col.title) ?? 0) + 1);
    }
  }
  const topUnmapped = [...unmappedCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([title, count]) => `${title} (×${count})`);

  const passed = results.filter((r) => r.passed).length;
  const totalFields = results.reduce((sum, r) => sum + Object.keys(r.lead).length, 0);

  return {
    runAt: new Date().toISOString(),
    boardId: boardId ?? flags.board,
    itemId: flags.item,
    flags,
    mappingFile: path.join(MONDAY_DIR, "mapping.json"),
    summary: {
      total: results.length,
      passed,
      warned: results.length - passed,
      fieldsExtractedAvg: results.length ? Math.round((totalFields / results.length) * 10) / 10 : 0,
      topUnmappedColumns: topUnmapped,
    },
    items: itemLogs,
  };
}

async function writeRunLog(log: RunLog): Promise<string> {
  await mkdir(LOG_DIR, { recursive: true });
  // Filesystem-safe ISO timestamp: 2026-05-15T14-23-01
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "T").slice(0, 19);
  const scope = log.boardId ? `board-${log.boardId}` : `item-${log.itemId ?? "unknown"}`;
  const filename = `${ts}_${scope}.json`;
  const filepath = path.join(LOG_DIR, filename);
  await writeFile(filepath, JSON.stringify(log, null, 2), "utf8");
  return filepath;
}

// ---------- Main ----------

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));

  const mondayApiKey = process.env.MONDAY_API_KEY;
  const openaiApiKey = process.env.OPENAI_API_KEY;

  if (!mondayApiKey) {
    console.error("❌  MONDAY_API_KEY is not set in your .env file.");
    console.error("    Generate a token at: Monday.com → Avatar → Developers → My Access Tokens");
    process.exit(1);
  }

  if (!flags.item && !flags.board) {
    console.error("❌  Provide --item <id> or --board <id>");
    console.error("");
    console.error("  Examples:");
    console.error("    npx tsx monday/run.ts --item 1234567890");
    console.error("    npx tsx monday/run.ts --board 9876543210 --ai");
    console.error("    npx tsx monday/run.ts --board 9876543210 --inspect-columns");
    process.exit(1);
  }

  const mapping = await loadMapping();
  if (mapping?.columnMap && Object.keys(mapping.columnMap).length > 0) {
    const n = Object.keys(mapping.columnMap).length;
    console.log(`📋  Loaded mapping.json (${n} column override${n !== 1 ? "s" : ""})`);
  } else {
    console.log("📋  No mapping.json overrides — using keyword auto-detection");
  }

  // ── Inspect columns mode ──────────────────────────────────────────────────
  if (flags.inspectColumns) {
    const boardId = flags.board ?? flags.item!;
    console.log(`\n🔍  Fetching column schema for board ${boardId}...\n`);
    const columns = await fetchBoardColumns(mondayApiKey, boardId);
    console.log(`Found ${columns.length} columns:\n`);
    console.log("  " + ["ID".padEnd(20), "Title".padEnd(35), "Type"].join("  "));
    console.log("  " + "─".repeat(70));
    for (const col of columns) {
      console.log("  " + [col.id.padEnd(20), col.title.padEnd(35), col.type].join("  "));
    }
    console.log("\n💡  Copy the Title values you need into monday/mapping.json\n");
    return;
  }

  // ── Fetch items ──────────────────────────────────────────────────────────
  let items: MondayItem[];
  let resolvedBoardId: string | undefined;

  if (flags.item) {
    console.log(`\n🔗  Fetching item ${flags.item} from Monday.com...`);
    const item = await fetchItem(mondayApiKey, flags.item);
    items = [item];
    resolvedBoardId = item.board.id;
    console.log(`    Found: "${item.name}" on board "${item.board.name}"\n`);

    if (mapping?.boardId && item.board.id !== mapping.boardId) {
      console.warn(`  ⚠️  mapping.json boardId is "${mapping.boardId}" but this item is on board "${item.board.id}"`);
    }
  } else {
    console.log(`\n🔗  Fetching board ${flags.board!} from Monday.com...`);
    const board = await fetchBoard(mondayApiKey, flags.board!);
    items = board.items_page.items;
    resolvedBoardId = board.id;
    console.log(`    Board: "${board.name}" — ${items.length} item${items.length !== 1 ? "s" : ""}\n`);

    if (mapping?.boardId && board.id !== mapping.boardId) {
      console.warn(`  ⚠️  mapping.json boardId is "${mapping.boardId}" but fetched board is "${board.id}"`);
    }
  }

  if (items.length === 0) {
    console.log("ℹ️   No items found. Nothing to do.");
    return;
  }

  // ── Process each item ────────────────────────────────────────────────────
  const results: Array<{ item: MondayItem } & ProcessResult & { outputFile?: string }> = [];

  for (const item of items) {
    process.stdout.write(`  Processing: ${item.name} (id: ${item.id})...\n`);
    const processed = await processItem(item, mapping, flags, openaiApiKey);

    let outputFile: string | undefined;
    if (!flags.dryRun) {
      outputFile = await writeLeadFile(flags.output, processed.slug, processed.lead);
    }

    results.push({ item, ...processed, outputFile });
  }

  // ── Console summary ──────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(60));
  console.log(`  Results: ${items.length} item${items.length !== 1 ? "s" : ""} processed`);
  console.log("═".repeat(60));

  let successCount = 0;
  let warnCount = 0;

  for (const r of results) {
    const icon = r.passed ? "✅" : "⚠️ ";
    const dest = r.outputFile
      ? `  →  ${r.outputFile}`
      : flags.dryRun ? "  [dry-run, not written]" : "";
    console.log(`  ${icon}  ${r.item.name}${dest}`);

    if (!r.passed) {
      warnCount++;
      for (const issue of r.issues) {
        console.log(`       ⚠  ${issue}`);
      }
    } else {
      successCount++;
    }

    if (flags.verbose || !r.passed) {
      console.log("     Lead fields extracted:");
      for (const [k, v] of Object.entries(r.lead)) {
        console.log(`       ${k}: ${JSON.stringify(v)}`);
      }
    }
  }

  console.log("═".repeat(60));

  if (successCount > 0 && !flags.dryRun) {
    console.log(`\n✅  ${successCount} lead JSON${successCount !== 1 ? "s" : ""} written to: ${flags.output}`);
    console.log(`    Run the pipeline with:`);
    for (const r of results.filter((r) => r.passed && r.outputFile)) {
      console.log(`      npm run prep -- --lead ${r.outputFile}`);
    }
  }

  if (warnCount > 0) {
    console.log(`\n⚠️   ${warnCount} item${warnCount !== 1 ? "s" : ""} had validation issues.`);
    console.log(
      "    Fix the missing required fields (company, aeName, aeEmail) in the JSON\n" +
      "    or add the column titles to monday/mapping.json and re-run."
    );
  }

  if (flags.dryRun) {
    console.log("\n(dry-run mode — no lead files were written)");
  }

  // ── Write run log ────────────────────────────────────────────────────────
  const log = buildRunLog(flags, mapping, resolvedBoardId, results);
  const logPath = await writeRunLog(log);
  console.log(`\n📝  Run log: ${logPath}`);
  console.log(`    Summary: ${log.summary.passed}/${log.summary.total} passed · avg ${log.summary.fieldsExtractedAvg} fields/item`);
  if (log.summary.topUnmappedColumns.length > 0) {
    console.log(`    Top unmapped columns: ${log.summary.topUnmappedColumns.slice(0, 3).join(" · ")}`);
  }
  if (flags.ai) {
    const totalCost = results.reduce((sum, r) => sum + (r.synthUsage?.estimatedCostUsd ?? 0), 0);
    const totalIn   = results.reduce((sum, r) => sum + (r.synthUsage?.inputTokens ?? 0), 0);
    const totalOut  = results.reduce((sum, r) => sum + (r.synthUsage?.outputTokens ?? 0), 0);
    console.log(`    AI cost: $${totalCost.toFixed(4)} · ${totalIn.toLocaleString()} in / ${totalOut.toLocaleString()} out tokens`);
  }

  console.log("");
}

main().catch((err) => {
  console.error("\n❌", err instanceof Error ? err.message : err);
  process.exit(1);
});
