/**
 * Arvaya brief — minimal HTTP server.
 *
 * Serves the iPad viewer (viewer/index.html) and exposes the brief API:
 *
 *   GET  /                          — serve the viewer
 *   GET  /api/briefs                — list all briefs across all companies
 *   GET  /api/briefs/:path          — fetch a brief.json by encoded relative path
 *   POST /api/briefs                — kick off a new orchestrator run; returns { runId }
 *   GET  /api/briefs/:runId/events  — SSE stream of stage progress for a run
 *
 * No framework dependency — uses Node's built-in `http` module so we
 * don't need to add Express to `package.json`. The route table is
 * shallow enough to read top-to-bottom.
 *
 * Boot:
 *   npm run serve            # tsx src/server.ts
 *
 * Env: same as the CLI (OPENAI_API_KEY, PERPLEXITY_API_KEY, FIRECRAWL_API_KEY,
 * optional APOLLO_API_KEY, optional PROFILES_DIR). Add PORT (default 5174)
 * and HOST (default 0.0.0.0) to control bind address.
 *
 * SECURITY NOTE: This is a single-tenant local server. No auth, no rate
 * limiting, no input sanitisation beyond Zod's LeadSchema. Do NOT expose
 * to the internet without putting it behind auth + reverse proxy +
 * proper rate limits. Phase 4A of the roadmap addresses this.
 */

import http from "node:http";
import { URL, fileURLToPath } from "node:url";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "./config.js";
import { runOrchestrator, subscribeToRun, type OrchestratorEvent } from "./orchestrator.js";
import { LeadSchema, type Lead } from "./types.js";

const PORT = parseInt(process.env.PORT || "5174", 10);
const HOST = process.env.HOST || "0.0.0.0";

const ROOT = path.dirname(fileURLToPath(import.meta.url)); // .../src
const PROJECT_ROOT = path.resolve(ROOT, "..");
const VIEWER_DIR = path.join(PROJECT_ROOT, "viewer");
const LEADS_DIR = path.join(PROJECT_ROOT, "leads");

// ---------- Helpers ----------

function send(res: http.ServerResponse, status: number, body: string | object, headers: Record<string, string> = {}): void {
  const isJson = typeof body === "object";
  res.writeHead(status, {
    "Content-Type": isJson ? "application/json; charset=utf-8" : (headers["Content-Type"] || "text/plain; charset=utf-8"),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function sendFile(res: http.ServerResponse, filePath: string, contentType: string): Promise<void> {
  try {
    const content = await readFile(filePath, "utf8");
    send(res, 200, content, { "Content-Type": contentType });
  } catch {
    send(res, 404, "Not found");
  }
}

// Walk profilesDir to build the list of briefs available.
// Layout: <profilesDir>/<companySlug>/<runId>/brief.json
async function listAllBriefs(): Promise<Array<Record<string, unknown>>> {
  const { profilesDir } = getConfig();
  const root = path.resolve(profilesDir);
  let companies: string[];
  try {
    companies = await readdir(root);
  } catch {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const slug of companies) {
    const companyPath = path.join(root, slug);
    let runs: string[];
    try {
      const s = await stat(companyPath);
      if (!s.isDirectory()) continue;
      runs = await readdir(companyPath);
    } catch {
      continue;
    }
    for (const runId of runs) {
      const briefPath = path.join(companyPath, runId, "brief.json");
      try {
        const raw = await readFile(briefPath, "utf8");
        const brief = JSON.parse(raw) as { meta?: Record<string, unknown> };
        const meta = brief.meta ?? {};
        out.push({
          company: meta["company"] ?? slug,
          runId: meta["runId"] ?? runId,
          generatedAt: meta["generatedAt"],
          meetingDate: meta["meetingDate"],
          signalQuality: meta["signalQuality"] ?? "moderate",
          passedVerification: meta["passedVerification"] ?? true,
          // Relative path from profilesDir for the GET-by-path endpoint.
          path: path.posix.join(slug, runId, "brief.json"),
        });
      } catch {
        // Skip runs that don't have a brief.json yet (failed or in-flight).
      }
    }
  }
  // Sort newest first.
  out.sort((a, b) => String(b["generatedAt"] ?? "").localeCompare(String(a["generatedAt"] ?? "")));
  return out;
}

/**
 * Walk leads/ and merge each stub with its latest brief (by mtime).
 * Output drives the viewer's "Pipeline" sidebar — every known company
 * shows up, with a brief-or-not status indicator.
 */
async function listAllLeads(): Promise<Array<Record<string, unknown>>> {
  let files: string[];
  try {
    files = await readdir(LEADS_DIR);
  } catch {
    return [];
  }
  const briefs = await listAllBriefs(); // already newest-first
  // Index briefs by companySlug for fast join.
  const briefsBySlug = new Map<string, Record<string, unknown>>();
  for (const b of briefs) {
    const slug = (b["path"] as string | undefined)?.split("/")[0];
    if (slug && !briefsBySlug.has(slug)) briefsBySlug.set(slug, b);
  }

  const out: Array<Record<string, unknown>> = [];
  for (const f of files) {
    if (!f.endsWith(".json") || f.startsWith("_")) continue;
    const leadPath = path.join(LEADS_DIR, f);
    try {
      const raw = await readFile(leadPath, "utf8");
      const lead = JSON.parse(raw) as Record<string, unknown>;
      const company = String(lead["company"] ?? f.replace(/\.json$/, ""));
      // Skip leads still on placeholder content (e.g. leftover from a
      // copy of _template.json — contains "<Replace with...>").
      if (company.includes("<") || company.length < 2) continue;
      const slug = slugify(company);
      const latest = briefsBySlug.get(slug);
      out.push({
        leadFile: f,
        company,
        slug,
        website: lead["website"] ?? null,
        prospectName: lead["prospectName"] ?? null,
        prospectTitle: lead["prospectTitle"] ?? null,
        meetingAt: lead["meetingAt"] ?? null,
        prospectArchetype: lead["prospectArchetype"] ?? null,
        dealStage: lead["dealStage"] ?? null,
        description: lead["description"] ?? null,
        sponsorLevel: lead["sponsorLevel"] ?? null,
        latestBrief: latest ?? null,
      });
    } catch {
      // Skip malformed leads silently.
    }
  }
  // Sort: meetings today/soon first, then unscheduled, then briefs by recency.
  out.sort((a, b) => {
    const am = (a["meetingAt"] as string | null) ?? "";
    const bm = (b["meetingAt"] as string | null) ?? "";
    if (am && bm) return am.localeCompare(bm);
    if (am) return -1;
    if (bm) return 1;
    return String(a["company"]).localeCompare(String(b["company"]));
  });
  return out;
}

/**
 * Mirror of `slugify` in `src/orchestrator.ts` — kept in sync so the
 * leads endpoint can join leads to briefs by the same slug rule.
 */
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

// ---------- Route handlers ----------

async function handleGetBriefs(res: http.ServerResponse): Promise<void> {
  const briefs = await listAllBriefs();
  send(res, 200, briefs);
}

async function handleGetLeads(res: http.ServerResponse): Promise<void> {
  const leads = await listAllLeads();
  send(res, 200, leads);
}

async function handleGetLead(res: http.ServerResponse, leadFile: string): Promise<void> {
  // Reject anything that tries to escape leads/.
  const safe = path.basename(leadFile);
  const abs = path.join(LEADS_DIR, safe);
  if (!abs.startsWith(LEADS_DIR + path.sep)) {
    send(res, 400, "Bad path");
    return;
  }
  try {
    const raw = await readFile(abs, "utf8");
    send(res, 200, raw, { "Content-Type": "application/json; charset=utf-8" });
  } catch {
    send(res, 404, "Lead not found");
  }
}

async function handleGetBrief(res: http.ServerResponse, relPath: string): Promise<void> {
  const { profilesDir } = getConfig();
  const root = path.resolve(profilesDir);
  // Reject any traversal — the relPath must stay inside profilesDir.
  const absolute = path.resolve(root, relPath);
  if (!absolute.startsWith(root + path.sep) && absolute !== root) {
    send(res, 400, "Bad path");
    return;
  }
  try {
    const raw = await readFile(absolute, "utf8");
    send(res, 200, raw, { "Content-Type": "application/json; charset=utf-8" });
  } catch {
    send(res, 404, "Brief not found");
  }
}

async function handlePostBrief(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readBody(req);
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    send(res, 400, { error: "Body is not valid JSON" });
    return;
  }
  const parsed = LeadSchema.safeParse(payload);
  if (!parsed.success) {
    send(res, 400, { error: "Invalid lead", issues: parsed.error.issues });
    return;
  }
  const lead: Lead = parsed.data;

  // We return the runId immediately and let the orchestrator continue in
  // the background. The client subscribes to /api/briefs/:runId/events
  // for progress. The runId is pre-generated here so the client can
  // start its SSE subscription before runOrchestrator actually emits its
  // first event.
  const runId = lead.runId ?? new Date().toISOString().replace(/[:.]/g, "-");
  const fullLead: Lead = { ...lead, runId };

  send(res, 202, { runId });

  // Fire-and-forget. Errors are emitted on the event bus (and persisted
  // to run.json by the orchestrator's own catch block).
  runOrchestrator(fullLead).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[server] orchestrator failed for run ${runId}:`, err);
  });
}

function handleEvents(req: http.IncomingMessage, res: http.ServerResponse, runId: string): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no", // disables nginx buffering if behind one
    "Access-Control-Allow-Origin": "*",
  });

  // Heartbeat to keep idle proxies from killing the connection.
  const heartbeat = setInterval(() => {
    try { res.write(`: keep-alive ${Date.now()}\n\n`); } catch { /* socket closed */ }
  }, 15_000);

  const unsubscribe = subscribeToRun(runId, (event: OrchestratorEvent) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      // Socket closed; the close listener below will clean up.
    }
  });

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---------- Server ----------

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.method) { send(res, 400, "Bad request"); return; }

  // CORS preflight.
  if (req.method === "OPTIONS") {
    send(res, 204, "");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathName = url.pathname;

  // --- Static viewer ---
  if (req.method === "GET" && (pathName === "/" || pathName === "/index.html")) {
    return sendFile(res, path.join(VIEWER_DIR, "index.html"), "text/html; charset=utf-8");
  }

  // --- API ---
  if (req.method === "GET" && pathName === "/api/briefs") {
    return handleGetBriefs(res);
  }
  if (req.method === "GET" && pathName === "/api/leads") {
    return handleGetLeads(res);
  }
  if (req.method === "GET" && pathName.startsWith("/api/leads/")) {
    const leadFile = decodeURIComponent(pathName.slice("/api/leads/".length));
    return handleGetLead(res, leadFile);
  }

  // SSE stream: /api/briefs/:runId/events
  const eventsMatch = pathName.match(/^\/api\/briefs\/([^/]+)\/events$/);
  if (req.method === "GET" && eventsMatch) {
    const runId = decodeURIComponent(eventsMatch[1]!);
    return handleEvents(req, res, runId);
  }

  // GET by relative path: /api/briefs/<slug>/<runId>/brief.json
  if (req.method === "GET" && pathName.startsWith("/api/briefs/")) {
    const relPath = decodeURIComponent(pathName.slice("/api/briefs/".length));
    return handleGetBrief(res, relPath);
  }

  if (req.method === "POST" && pathName === "/api/briefs") {
    return handlePostBrief(req, res);
  }

  send(res, 404, "Not found");
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`\n🛰️  Arvaya brief server listening on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`   iPad viewer: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/\n`);
});
