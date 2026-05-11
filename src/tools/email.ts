/**
 * Email delivery via Resend.
 *
 * Optional: if RESEND_API_KEY or EMAIL_FROM is unset, the orchestrator
 * skips delivery and records the reason. The brief is still on disk in
 * the profile folder, so a missing email config is non-fatal.
 *
 * Setup:
 *   1. Sign up at resend.com — free tier covers 100 emails/day.
 *   2. Add and verify a sending domain (~5 min DNS setup).
 *   3. Create an API key.
 *   4. Set RESEND_API_KEY and EMAIL_FROM in .env.
 *   5. (Optional) Set EMAIL_REPLY_TO if Arvaya wants replies routed
 *      somewhere different from the From address.
 */

import { Resend } from "resend";
import { getConfig } from "../config.js";

export interface SendBriefArgs {
  to: string;
  subject: string;
  /** The brief in markdown. Sent as text/plain plus a basic HTML render. */
  markdown: string;
}

export interface DeliveryResult {
  delivered: boolean;
  reason?: string;
  /** Resend's message ID if delivered. */
  id?: string;
}

let cachedClient: Resend | undefined;

function client(apiKey: string): Resend {
  if (!cachedClient) cachedClient = new Resend(apiKey);
  return cachedClient;
}

export async function sendBriefEmail(args: SendBriefArgs): Promise<DeliveryResult> {
  const config = getConfig();

  if (!config.resendApiKey || !config.emailFrom) {
    return {
      delivered: false,
      reason:
        "Email delivery skipped — set RESEND_API_KEY and EMAIL_FROM in .env to enable.",
    };
  }

  try {
    const { data, error } = await client(config.resendApiKey).emails.send({
      from: config.emailFrom,
      to: args.to,
      replyTo: config.emailReplyTo,
      subject: args.subject,
      text: args.markdown,
      html: markdownToHtml(args.markdown),
    });

    if (error) {
      return { delivered: false, reason: `Resend error: ${error.message}` };
    }
    return { delivered: true, id: data?.id };
  } catch (err) {
    return {
      delivered: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------- Tiny markdown → HTML ----------
//
// Handles the subset our briefRenderer emits: H1/H2, bullets (with one
// level of continuation indent for objection items), paragraphs,
// blockquotes, bold, links. Not full markdown — but enough that the
// AE's email client renders something readable.

export function markdownToHtml(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inList = false;
  let lastWasLi = false;

  const closeList = (): void => {
    if (inList) {
      // Close the dangling <li> if we're mid-item before closing the <ul>.
      if (lastWasLi) {
        out[out.length - 1] = `${out[out.length - 1]}</li>`;
        lastWasLi = false;
      }
      out.push("</ul>");
      inList = false;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");

    if (/^# /.test(line)) {
      closeList();
      out.push(`<h1>${inline(line.slice(2))}</h1>`);
    } else if (/^## /.test(line)) {
      closeList();
      out.push(`<h2>${inline(line.slice(3))}</h2>`);
    } else if (/^- /.test(line)) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(line.slice(2))}`);
      lastWasLi = true;
    } else if (/^ {2}/.test(line) && lastWasLi) {
      // Continuation of the previous list item (objection responses).
      const last = out.length - 1;
      const prev = out[last] ?? "";
      out[last] = `${prev}<br>${inline(line.trimStart())}`;
    } else if (/^> /.test(line)) {
      closeList();
      out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`);
    } else if (line.trim() === "") {
      if (lastWasLi) {
        out[out.length - 1] = `${out[out.length - 1]}</li>`;
        lastWasLi = false;
      }
      // paragraph break: no-op, paragraphs are separated by spacing
    } else if (/^_.+_$/.test(line)) {
      closeList();
      out.push(`<p><em>${inline(line.slice(1, -1))}</em></p>`);
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  if (lastWasLi) out[out.length - 1] = `${out[out.length - 1]}</li>`;
  closeList();

  return [
    '<!doctype html><html><body style="font-family: -apple-system, system-ui, ' +
      'BlinkMacSystemFont, sans-serif; max-width: 720px; margin: 0 auto; ' +
      'padding: 24px; line-height: 1.55; color: #1a1a1a;">',
    out.join("\n"),
    "</body></html>",
  ].join("\n");
}

function inline(text: string): string {
  let s = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // Links first so the bracket pattern doesn't get eaten by bold.
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // Bold.
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return s;
}
