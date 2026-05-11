/**
 * Robustly pull the first JSON object/array out of an assistant's reply.
 *
 * Models occasionally wrap JSON in ```json fences, prefix it with prose,
 * or add trailing commentary. We tolerate all of that, but we do NOT
 * try to repair invalid JSON — if parsing fails, we throw so the
 * orchestrator can log the raw text and fail loudly.
 */

export function extractJson(text: string): unknown {
  const stripped = stripCodeFences(text).trim();

  // Fast path: whole reply is JSON.
  try {
    return JSON.parse(stripped);
  } catch {
    // fall through
  }

  // Find the first balanced { ... } or [ ... ].
  const start = firstJsonStart(stripped);
  if (start < 0) {
    throw new Error("extractJson: no JSON object/array found in assistant output");
  }

  const open = stripped[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        return JSON.parse(stripped.slice(start, i + 1));
      }
    }
  }
  throw new Error("extractJson: unbalanced JSON in assistant output");
}

function stripCodeFences(text: string): string {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return fence?.[1] ?? text;
}

function firstJsonStart(text: string): number {
  const obj = text.indexOf("{");
  const arr = text.indexOf("[");
  if (obj === -1) return arr;
  if (arr === -1) return obj;
  return Math.min(obj, arr);
}
