/**
 * Generate briefs for every lead in `leads/`.
 *
 * Behaviour:
 *   - Walks `leads/*.json` in alphabetical order.
 *   - SKIPS the underscore-prefixed template (`_template.json`) and any
 *     lead whose `company` field still contains a `<` placeholder.
 *   - SKIPS any company that already has a brief generated within the
 *     last 24h (use `--force` to override; `--max-age-hours N` to tune).
 *   - Runs `runOrchestrator` with bounded concurrency (default 2) so we
 *     don't hammer upstream APIs.
 *   - Per-lead failures are logged but never kill the batch.
 *   - Streams a one-line-per-event status feed to stdout.
 *
 * Flags:
 *   --concurrency N      Parallel runs (default 2). 1–4 is sensible.
 *   --limit N            Only process the first N eligible leads (great for smoke-testing).
 *   --force              Don't skip same-day briefs.
 *   --max-age-hours N    "Recent" window for the skip rule. Default 24.
 *   --only <slug,slug>   Only process these specific lead slugs (comma-separated).
 *
 * Boot:
 *   npm run batch:briefs                                     # all eligible
 *   npm run batch:briefs -- --limit 3 --concurrency 1        # smoke test 3
 *   npm run batch:briefs -- --only acelab,box,deltek         # specific ones
 *   npm run batch:briefs -- --force                          # regenerate all
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runOrchestrator } from "../src/orchestrator.js";
import { LeadSchema, type Lead } from "../src/types.js";
import { getConfig } from "../src/config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const LEADS_DIR = path.join(ROOT, "leads");

// ---------- CLI flag parsing ----------

interface BatchFlags {
  concurrency: number;
  limit?: number;
  force: boolean;
  maxAgeHours: number;
  only?: string[];
}

function parseFlags(argv: string[]): BatchFlags {
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
  return {
    concurrency: out["concurrency"] ? parseInt(out["concurrency"], 10) : 2,
    limit: out["limit"] ? parseInt(out["limit"], 10) : undefined,
    force: out["force"] === "true",
    maxAgeHours: out["max-age-hours"] ? parseInt(out["max-age-hours"], 10) : 24,
    only: out["only"]
      ? out["only"]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
  };
}

// ---------- Slug + skip-rule helpers ----------

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/&/g, "and")
      .replace(/\//g, "-")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "unknown"
  );
}

async function hasRecentBrief(slug: string, maxAgeHours: number): Promise<boolean> {
  const { profilesDir } = getConfig();
  const companyDir = path.join(path.resolve(profilesDir), slug);
  try {
    const runs = await readdir(companyDir);
    for (const runId of runs) {
      const brief = path.join(companyDir, runId, "brief.json");
      try {
        const s = await stat(brief);
        const ageMs = Date.now() - s.mtimeMs;
        if (ageMs < maxAgeHours * 3600 * 1000) return true;
      } catch { /* ignore */ }
    }
  } catch { /* no folder yet */ }
  return false;
}

// ---------- Concurrency helper ----------

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------- Status helpers ----------

interface RunOutcome {
  slug: string;
  company: string;
  status: "ok" | "skipped" | "failed";
  durationMs?: number;
  error?: string;
  profilePath?: string;
}

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function logLine(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[${ts()}] ${msg}`);
}

// ---------- Main ----------

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));

  // 1. Discover eligible leads.
  let files: string[];
  try {
    files = (await readdir(LEADS_DIR)).filter(
      (f) => f.endsWith(".json") && !f.startsWith("_"),
    );
  } catch {
    logLine("FATAL: leads/ directory not readable.");
    process.exit(1);
    return;
  }

  interface Eligible { file: string; slug: string; lead: Lead; }
  const eligible: Eligible[] = [];

  for (const f of files.sort()) {
    const raw = await readFile(path.join(LEADS_DIR, f), "utf8");
    let parsedJson: unknown;
    try { parsedJson = JSON.parse(raw); } catch { logLine(`  ⊘ ${f} — invalid JSON, skipping`); continue; }
    const company = (parsedJson as Record<string, unknown>)?.["company"];
    if (typeof company !== "string" || company.includes("<")) {
      logLine(`  ⊘ ${f} — placeholder content (company contains '<'), skipping`);
      continue;
    }
    const result = LeadSchema.safeParse(parsedJson);
    if (!result.success) {
      logLine(`  ⊘ ${f} — failed schema: ${result.error.issues.map((i) => i.message).slice(0, 2).join("; ")}`);
      continue;
    }
    const slug = slugify(result.data.company);
    if (flags.only && !flags.only.includes(slug)) continue;
    eligible.push({ file: f, slug, lead: result.data });
  }

  if (eligible.length === 0) {
    logLine("No eligible leads to run. Exiting.");
    return;
  }

  // 2. Apply skip-recent filter (unless --force).
  const queue: Eligible[] = [];
  for (const e of eligible) {
    if (!flags.force && (await hasRecentBrief(e.slug, flags.maxAgeHours))) {
      logLine(`  ⊙ ${e.slug} — brief exists within last ${flags.maxAgeHours}h, skipping (use --force to override)`);
      continue;
    }
    queue.push(e);
  }

  if (flags.limit) queue.splice(flags.limit);

  if (queue.length === 0) {
    logLine("Everything up to date. Exiting.");
    return;
  }

  logLine(`Running ${queue.length} brief${queue.length === 1 ? "" : "s"} with concurrency ${flags.concurrency}…`);
  logLine(`Eligible queue: ${queue.map((q) => q.slug).join(", ")}`);

  const startedAt = Date.now();
  const outcomes: RunOutcome[] = await runWithConcurrency(
    queue,
    flags.concurrency,
    async (item, idx) => {
      const t0 = Date.now();
      logLine(`▶ [${idx + 1}/${queue.length}] ${item.slug} — starting…`);
      try {
        const out = await runOrchestrator(item.lead);
        const ms = Date.now() - t0;
        logLine(`✓ [${idx + 1}/${queue.length}] ${item.slug} — done in ${(ms / 1000).toFixed(1)}s (${out.briefPath})`);
        return {
          slug: item.slug,
          company: item.lead.company,
          status: "ok" as const,
          durationMs: ms,
          profilePath: out.profilePath,
        };
      } catch (err) {
        const ms = Date.now() - t0;
        const msg = err instanceof Error ? err.message : String(err);
        logLine(`✖ [${idx + 1}/${queue.length}] ${item.slug} — FAILED after ${(ms / 1000).toFixed(1)}s: ${msg.slice(0, 200)}`);
        return {
          slug: item.slug,
          company: item.lead.company,
          status: "failed" as const,
          durationMs: ms,
          error: msg,
        };
      }
    },
  );

  // 3. Summary.
  const totalMs = Date.now() - startedAt;
  const ok = outcomes.filter((o) => o.status === "ok").length;
  const failed = outcomes.filter((o) => o.status === "failed").length;
  logLine("─".repeat(60));
  logLine(`SUMMARY: ${ok} ok, ${failed} failed in ${(totalMs / 60000).toFixed(1)}m total`);
  if (failed > 0) {
    logLine("Failures:");
    for (const o of outcomes.filter((x) => x.status === "failed")) {
      logLine(`  ✖ ${o.slug}: ${(o.error || "").slice(0, 200)}`);
    }
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
