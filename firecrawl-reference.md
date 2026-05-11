# Firecrawl Reference

A consolidated guide compiled from Firecrawl's official docs, GitHub repo, npm SDK, and community write-ups. Current as of May 2026. Optimized for evaluating fit and writing integration code.

---

## 1. What it is

Firecrawl is a hosted web-extraction API that turns URLs into clean, LLM-ready content. The pitch is "URL in, markdown out" — you don't drive a browser, you don't write selectors, you POST a URL and you get structured data back. Built and operated by Mendable, open source under AGPL-3.0, with a managed cloud at `api.firecrawl.dev` and a self-host option via Docker.

The product surface has expanded into six functional areas:

- **Scrape** — fetch one URL, return markdown / HTML / structured JSON / screenshot
- **Crawl** — recursively follow links across a site, scrape every page
- **Map** — list every URL on a domain in seconds, no scraping
- **Search** — web search + scrape in one call, returns search hits with full page content
- **Agent** (formerly Extract) — autonomous research loop given a natural-language goal
- **Interact** — click, type, wait, screenshot — drive interactive pages before scraping
- **Batch Scrape** — same shape as Scrape but for many URLs in one job

---

## 2. Pricing and limits at a glance

Subscription model with monthly credit allotments. No pure pay-as-you-go.

| Plan | Monthly credits | Concurrent | Overage |
|---|---|---|---|
| Free | 500 lifetime credits (not 500/mo) | low | n/a |
| Hobby | 3,000 | 5 | $9 / extra 1k |
| Standard | 100,000 | higher | $0.00083 / credit |
| Growth | larger volume tiers | higher | custom |
| Scale / Enterprise | custom upfront annual | custom | custom |

**Credit cost per action:**

| Action | Credits |
|---|---|
| Scrape (markdown only) | 1 |
| Search (per result) | 1 |
| Map | 1 (per request, not per URL) |
| Interact (per action) | 5 |
| JSON extraction with LLM | 5 (often more) |
| JSON extraction + Enhanced Mode | up to 9–10 per page |
| Agent endpoint | varies — meters internal scrape + reasoning |

Credits do not roll over month to month (with limited exceptions for auto-recharge credits and Enterprise upfront grants).

Rate limits scale with plan. Subscription plans support auto-recharge: if you dip below a threshold, additional credits are purchased automatically.

---

## 3. Authentication

API-key auth via Bearer token in the `Authorization` header.

```
Authorization: Bearer fc-YOUR-API-KEY
```

The Node SDK reads from the `FIRECRAWL_API_KEY` environment variable by default, or accepts an explicit `apiKey` argument.

---

## 4. Endpoints

### `/v2/scrape` — single URL

POST a URL, get back content in the formats you request. The most-used endpoint.

**Core params:**

- `url` (required)
- `formats` — array. Choices: `markdown`, `html`, `rawHtml`, `links`, `screenshot`, `screenshot@fullPage`, `summary`, `json` (with schema or prompt)
- `onlyMainContent` (default true) — strip nav/footer/sidebars
- `includeTags`, `excludeTags` — DOM selectors
- `waitFor` — milliseconds to wait before scraping (for JS-heavy pages)
- `timeout` — overall timeout in ms
- `actions` — array of interactive steps (see Interact section)
- `mobile` — boolean, render mobile viewport
- `location` — geo settings: `{ country, languages }`
- `headers` — custom request headers
- `proxy` — `basic` | `stealth` (stealth uses residential proxy infra; costs more credits)

**Return shape (simplified):**

```json
{
  "success": true,
  "data": {
    "markdown": "...",
    "html": "...",
    "links": ["..."],
    "screenshot": "https://...",
    "json": { /* structured output if json format */ },
    "metadata": {
      "title": "...",
      "description": "...",
      "language": "en",
      "sourceURL": "...",
      "url": "...",
      "statusCode": 200,
      "contentType": "text/html",
      "ogTitle": "...",
      "ogImage": "...",
      "creditsUsed": 1
    }
  }
}
```

### `/v2/crawl` — entire site

Recursively walks a starting URL, scrapes each page with the same options as `/scrape`. Async by default.

**Core params:**

- `url` (required) — starting URL
- `limit` — max pages
- `maxDepth` — link-following depth
- `includePaths`, `excludePaths` — regex patterns
- `allowBackwardLinks` — visit URLs above the starting path
- `allowExternalLinks` — leave the starting domain
- `webhook` — POST receiver for live page events
- `scrapeOptions` — passed to each per-page scrape (`formats`, `onlyMainContent`, etc.)

**Lifecycle:**

1. POST returns `{ success, id, url }` — the job ID
2. GET `/v2/crawl/{id}` to poll status
3. Or pass `webhook` and let Firecrawl push events to your endpoint as pages finish
4. Or use the SDK's `watcher()` for WebSocket streaming

### `/v2/map` — site URL discovery

Returns every URL on a site without scraping content. Designed for sub-3-second response on most sites.

**Core params:**

- `url`
- `search` — relevance filter (e.g. `"blog"` ranks blog URLs higher)
- `limit` — max URLs (cap is 5,000 per request)
- `includeSubdomains` (default false)
- `sitemap` — `include` (default), `skip`, or `only`
- `ignoreQueryParameters` (default false) — collapses `?ref=abc` and `?ref=xyz` into one URL

**Response:**

```json
{ "success": true, "links": ["https://...", "https://..."] }
```

### `/v2/search` — web search + scrape combined

Search the web and optionally scrape every result in one call. The "saves a round trip" endpoint.

**Core params:**

- `query` (required)
- `limit` — max results
- `sources` — defaults to `['web']`. Other options: `news`, `github`, `academic`
- `categories` — filter buckets
- `location` — `"Germany"`, `"San Francisco,California,United States"`
- `country` — ISO code
- `tbs` — Google-style time filter (`qdr:d`, `qdr:w`, `qdr:m`, custom date ranges)
- `includeDomains`, `excludeDomains` — hostnames only (no protocol/path)
- `scrapeOptions` — when present, each result is scraped (markdown/summary/etc.). Without it you only get URL + title + description
- `timeout` — ms
- `ignoreInvalidURLs` — boolean

### `/v2/agent` — autonomous research (formerly Extract)

Pass a natural-language goal, get back structured findings. The agent searches, scrapes, reasons, and returns a synthesized result with source attribution. Powered by Firecrawl's "Spark 1 Pro" / "Spark 1 Mini" reasoning models.

**Use when:** you don't know which URLs to scrape ahead of time and want the system to decide. Designed to slot into LangGraph, CrewAI, OpenAI Agents SDK.

**Tradeoff vs. Scrape:** more expensive, more opaque, less deterministic. For a known URL list, Scrape or Batch Scrape is cheaper and faster.

### `/v2/batch/scrape` — many URLs at once

Pass an array of URLs with shared `scrapeOptions`. Firecrawl runs them concurrently with managed rate limiting. Webhook support so you can stream results as each page finishes.

**Sync vs async:**

- `batch_scrape()` — sync, blocks until all done
- `start_batch_scrape()` — async, returns job ID, poll or use webhook

### `/v2/scrape/{id}/interact` — drive a page

Interact lives on top of scrape. After a scrape, you can issue actions against the loaded page using either natural-language prompts or Playwright-style code, then re-capture the page state.

**Action types:**

- `click` — `{ type: "click", selector: "..." }`
- `type` (sometimes called `write`) — `{ type: "type", text: "...", selector: "..." }`
- `wait` — `{ type: "wait", milliseconds: 2000 }` (or wait for selector)
- `press` — keyboard keys
- `scroll` — by amount or to element
- `screenshot` — `{ type: "screenshot", fullPage: true }` — appears in `actions.screenshots`

**Practical rule from the docs:** pair every click and write with a wait either before or after — pages need time to fetch and render after each interaction.

Note: a `screenshot` requested in `formats` always runs after all actions complete. To capture intermediate state (between clicks), use the `screenshot` action.

---

## 5. Output formats

The `formats` array in scrape (and `scrapeOptions` in crawl/batch/search) controls what you get back. Each format has its own credit cost.

| Format | What it returns | Notes |
|---|---|---|
| `markdown` | Cleaned markdown of main content | Default; the workhorse format |
| `html` | Cleaned HTML | After Firecrawl's processing |
| `rawHtml` | Original HTML | No cleanup |
| `links` | Array of all hyperlinks on page | Useful for hand-rolled crawls |
| `screenshot` | Above-the-fold PNG URL | |
| `screenshot@fullPage` | Full-page PNG URL | |
| `summary` | LLM-generated condensed content | Cheaper than full extraction |
| `json` | Structured JSON | Requires `prompt` and/or `schema` |

For `json`, you can pass either a Zod/JSON schema (preferred for stable field names) or just a prompt (LLM picks the shape, may drift between runs).

---

## 6. Structured data extraction

The most powerful feature for AI workflows. Two modes:

**Schema-driven (recommended for production):**

```ts
import Firecrawl from "@mendable/firecrawl-js";
import { z } from "zod";

const firecrawl = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY });

const schema = z.object({
  companyName: z.string(),
  ceoName: z.string(),
  fundingTotalUSD: z.number().optional(),
  recentNewsHeadlines: z.array(z.string()),
});

const result = await firecrawl.scrape("https://example.com/about", {
  formats: [{ type: "json", schema }],
});

console.log(result.data.json); // matches schema
```

**Prompt-only:**

```ts
const result = await firecrawl.scrape("https://example.com/about", {
  formats: [{ type: "json", prompt: "Extract company name, CEO, and total funding raised." }],
});
```

Schema-driven is more expensive per call but field names are stable across runs — that's what you want when downstream code parses the output.

---

## 7. Node.js SDK

**Install:**

```bash
npm i @mendable/firecrawl-js
```

(Latest at writing: 4.18.x. Confirm current version with `npm view @mendable/firecrawl-js`.)

**Initialize:**

```ts
import Firecrawl from "@mendable/firecrawl-js";

const firecrawl = new Firecrawl({
  apiKey: process.env.FIRECRAWL_API_KEY, // or pass directly
  // apiUrl: "https://api.firecrawl.dev"  // override for self-host
});
```

**Core methods:**

```ts
// Single page
const scrape = await firecrawl.scrape("https://example.com", {
  formats: ["markdown", "html"],
});

// Site URL discovery
const map = await firecrawl.map("https://example.com", {
  search: "blog",
  limit: 200,
});

// Crawl whole site (sync — blocks until done)
const crawl = await firecrawl.crawl("https://example.com", {
  limit: 100,
  scrapeOptions: { formats: ["markdown"] },
  pollInterval: 2,
});

// Crawl async (returns job id)
const job = await firecrawl.startCrawl("https://example.com", { limit: 1000 });
const status = await firecrawl.getCrawlStatus(job.id);

// Search + scrape
const results = await firecrawl.search("Northwind Logistics layoffs 2026", {
  limit: 5,
  scrapeOptions: { formats: ["markdown"] },
});

// Structured extraction across multiple URLs
const extract = await firecrawl.extract({
  urls: ["https://example.com/about"],
  prompt: "Extract company info",
  schema: zodSchema,
});

// Batch scrape
const batch = await firecrawl.batchScrape({
  urls: ["https://a.com", "https://b.com", "https://c.com"],
  scrapeOptions: { formats: ["markdown"] },
});
```

The SDK handles pagination, retries, async polling, and async-job WebSocket streaming under the hood. Errors come back as descriptive exceptions.

**WebSocket watcher for live crawl events:**

```ts
const watcher = await firecrawl.watcher(jobId);
for await (const snapshot of watcher) {
  if (snapshot.status === "completed" || snapshot.status === "failed") break;
  // snapshot.data has the pages scraped so far
}
```

---

## 8. Webhooks (for crawl and batch jobs)

Pass a `webhook` URL when starting a crawl or batch job. Firecrawl POSTs JSON to that URL on every event:

- Page completed
- Job started / updated / completed
- Error

Your endpoint reads the JSON body and reacts. This is the right pattern when:

- You're crawling thousands of pages and don't want to hold a long-running connection
- You want to start downstream work (embedding, indexing) the moment a page is done
- You're running serverless and can't keep polling

Webhook payloads include the page data, job ID, and event type, so you can correlate.

---

## 9. Self-hosting

Open source under AGPL-3.0. Repo at `github.com/firecrawl/firecrawl`.

**Requirements:**

- Docker + Docker Compose
- 2 GB RAM minimum
- `.env` with `PORT=3002`, `HOST=0.0.0.0`, `USE_DB_AUTHENTICATION=false`, a `BULL_AUTH_KEY`
- Redis and Playwright are managed by the provided Docker Compose

**Caveats:**

- **No Fire-engine.** The cloud version uses Fire-engine for stealth proxies, IP rotation, and bot-detection bypass. Self-hosted instances do not have access to it. Sites with serious anti-bot defenses (Cloudflare hard mode, LinkedIn, etc.) will fail or get blocked.
- **No managed rate-limit handling.** You're on your own for retries.
- **Kubernetes manifests included** for production deployments.
- A community fork called `firecrawl-simple` (devflowinc) strips out billing and AI features for a simpler self-host story if you don't need extraction.

If you need stealth scraping on hostile sites, stay on the cloud product or pair self-hosted with a proxy provider.

---

## 10. MCP server (Cursor / Claude / agent integration)

Firecrawl publishes an official MCP server at `github.com/firecrawl/firecrawl-mcp-server`. Adds Firecrawl as a tool inside any MCP-compatible client (Cursor, Claude Desktop, Claude Code, etc.). For our use case (raw Messages API in Node) we don't need it — but it's the right path if you want Firecrawl available inside an interactive Claude environment.

There's also a Docker image `mcp/firecrawl` for running the MCP server in containers.

---

## 11. Errors and response shape

Standard HTTP semantics:

- `2xx` — success
- `4xx` — your fault: bad params, bad API key, quota exhausted, unsupported URL
- `5xx` — Firecrawl side: transient infra issues; retry with backoff

**Common 400s seen in the wild:**

- `Invalid schema for response_format` — your JSON schema needs `additionalProperties: false` set explicitly
- `When 'extract' or 'json' format is specified, corresponding options must be provided` — you asked for JSON output but didn't pass `prompt` or `schema`
- Quota / rate limit errors — surface as 429 with retry-after-style hints

**Known SDK quirks:**

- `metadata.language` is documented as a string but has been intermittently returned as a list in some responses. Defensive code: `Array.isArray(meta.language) ? meta.language[0] : meta.language`.
- Crawl job status occasionally reports `Failed or Stopped` for jobs that actually succeeded. Inspect the result data, not just the status string.

---

## 12. v1 vs v2

The docs and SDK have settled on `/v2/...` endpoints as the modern surface. Older `/v0/...` paths still exist for backward compatibility and you'll see them in older blog posts. New integrations should use v2 for current params and response shapes (formats array, structured `metadata`, async job IDs, webhook v1 payloads).

---

## 13. Practical fit for the Arvaya pipeline

Mapping Firecrawl's surface to what we actually need in the discovery-prep agent:

- **`/scrape` with `formats: ["markdown"]`** — primary tool. Researcher calls this on high-value URLs surfaced by `web_search` (exec interviews, blog posts, earnings transcripts).
- **`/scrape` with `formats: [{ type: "json", schema }]`** — possibly useful for the Researcher to pull structured "Recent leadership announcements" off About pages. But adds 5–10x credits per call. Probably not worth it given web_search snippets are usually enough.
- **`/search`** — overlaps with Anthropic's native `web_search`. Skip; we already have search via the model.
- **`/agent`** — overlaps with what our orchestrator does in TypeScript. Skip; reproducing agent control in our own code is the whole point of the pipeline design.
- **`/crawl`** — not needed. We don't want to walk full sites; we want targeted page reads.
- **`/map`** — situationally useful if the Researcher wants to find "the careers page" or "the blog index" before scraping. Worth keeping in mind as a future tool.
- **`/batch/scrape`** — overkill. Our research surface per prospect is ≤5 pages.
- **`/interact`** — not needed unless we hit a JS-only page. Browserbase Fetch is the better fallback there.

**Recommended Firecrawl tool surface for the agent:** just `firecrawl_scrape(url, formats)`. Don't over-tool.

---

## 14. Quick-start integration code (drop-in)

Replaces / matches what's already in `src/tools/firecrawl.ts`:

```ts
import Firecrawl from "@mendable/firecrawl-js";
import { z } from "zod";

const firecrawl = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY! });

export const firecrawlScrapeInputSchema = z.object({
  url: z.string().url(),
  formats: z.array(z.enum(["markdown", "html", "summary", "links"])).default(["markdown"]),
  onlyMainContent: z.boolean().default(true),
  waitFor: z.number().int().nonnegative().optional(),
});

export type FirecrawlScrapeInput = z.infer<typeof firecrawlScrapeInputSchema>;

export async function firecrawlScrape(input: FirecrawlScrapeInput) {
  const result = await firecrawl.scrape(input.url, {
    formats: input.formats,
    onlyMainContent: input.onlyMainContent,
    waitFor: input.waitFor,
  });
  if (!result.success) {
    throw new Error(`Firecrawl failed for ${input.url}`);
  }
  return {
    url: result.data.metadata?.url ?? input.url,
    title: result.data.metadata?.title ?? null,
    language: Array.isArray(result.data.metadata?.language)
      ? result.data.metadata.language[0]
      : result.data.metadata?.language ?? null,
    statusCode: result.data.metadata?.statusCode ?? null,
    markdown: result.data.markdown ?? null,
    publishedAt: null, // Firecrawl doesn't reliably surface this; parse from metadata if needed
  };
}
```

For the Claude tool descriptor (used by the Researcher agent):

```ts
export const firecrawlScrapeTool = {
  name: "firecrawl_scrape",
  description:
    "Fetch a URL and return its main content as clean markdown. Use only on high-value URLs (executive interviews, earnings transcripts, long-form blog posts) where the search snippet is too thin to support a defensible claim. Cap at 5 calls per run.",
  input_schema: zodToJsonSchema(firecrawlScrapeInputSchema),
};
```

---

## 15. Decision summary

**Use Firecrawl for:** clean markdown of one specific URL. That's it for our pipeline.

**Don't use Firecrawl for:** general web search (use Anthropic's native `web_search`), site crawling (we don't need it), structured extraction (cheaper to let Claude parse the markdown itself), or anything behind a login (use Browserbase).

**Cost in our setup:** 1 credit per scrape × ≤5 scrapes per run = 5 credits per prospect brief. On the Hobby plan that's $0.015 per brief at marginal cost; on Standard, less than a cent.

**Risk:** sites with hostile anti-bot defenses (LinkedIn especially) — Firecrawl's cloud has Fire-engine to handle these, but recall is still spotty on LinkedIn. Plan for that with a Browserbase fallback as previously discussed.

---

## Sources

- [Firecrawl docs](https://docs.firecrawl.dev/introduction)
- [Firecrawl API reference](https://docs.firecrawl.dev/api-reference/introduction)
- [Scrape endpoint](https://docs.firecrawl.dev/api-reference/endpoint/scrape)
- [Crawl feature](https://docs.firecrawl.dev/features/crawl)
- [Map endpoint](https://docs.firecrawl.dev/api-reference/endpoint/map)
- [Search endpoint](https://docs.firecrawl.dev/api-reference/endpoint/search)
- [Batch Scrape](https://docs.firecrawl.dev/features/batch-scrape)
- [Interact](https://docs.firecrawl.dev/features/interact)
- [LLM extract / JSON mode](https://docs.firecrawl.dev/features/llm-extract)
- [Deep Research](https://docs.firecrawl.dev/features/alpha/deep-research)
- [Rate limits](https://docs.firecrawl.dev/rate-limits)
- [Pricing](https://www.firecrawl.dev/pricing)
- [Self-hosting guide](https://github.com/firecrawl/firecrawl/blob/main/SELF_HOST.md)
- [GitHub repo](https://github.com/firecrawl/firecrawl)
- [Node SDK on npm](https://www.npmjs.com/package/@mendable/firecrawl-js)
- [Node SDK docs](https://docs.firecrawl.dev/sdks/node)
- [MCP server](https://github.com/firecrawl/firecrawl-mcp-server)
- [Webhooks announcement](https://www.firecrawl.dev/blog/launch-week-i-day-7-webhooks)
- [Mastering Scrape (blog)](https://www.firecrawl.dev/blog/mastering-firecrawl-scrape-endpoint)
- [Mastering Crawl (blog)](https://www.firecrawl.dev/blog/mastering-the-crawl-endpoint-in-firecrawl)
- [Mastering Search (blog)](https://www.firecrawl.dev/blog/mastering-firecrawl-search-endpoint)
- [Mastering Extract (blog)](https://www.firecrawl.dev/blog/mastering-firecrawl-extract-endpoint)
