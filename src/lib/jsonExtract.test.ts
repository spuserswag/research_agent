/**
 * Hermetic tests for jsonExtract — no network, no keys.
 *
 * Covers the shapes assistant outputs actually take in the wild:
 *   - bare JSON
 *   - JSON wrapped in ```json fences
 *   - JSON preceded by prose
 *   - JSON containing strings with braces and quotes
 *   - malformed JSON (must throw — we'd rather fail loud than guess)
 */

import { describe, expect, it } from "vitest";
import { extractJson } from "./jsonExtract.js";

describe("extractJson", () => {
  it("parses a bare JSON object", () => {
    const out = extractJson(`{"a": 1, "b": "two"}`);
    expect(out).toEqual({ a: 1, b: "two" });
  });

  it("parses a bare JSON array", () => {
    const out = extractJson(`[1, 2, 3]`);
    expect(out).toEqual([1, 2, 3]);
  });

  it("strips ```json fences", () => {
    const text = "```json\n{\"hello\": \"world\"}\n```";
    expect(extractJson(text)).toEqual({ hello: "world" });
  });

  it("strips ``` fences without language tag", () => {
    const text = "```\n{\"x\": true}\n```";
    expect(extractJson(text)).toEqual({ x: true });
  });

  it("finds JSON after leading prose", () => {
    const text = `Sure, here is the JSON you asked for:\n\n{"k": [1, 2]}`;
    expect(extractJson(text)).toEqual({ k: [1, 2] });
  });

  it("respects braces inside string values", () => {
    // Realistic case: clean prose, then JSON whose values contain braces.
    const text = `Here is the JSON: {"label": "weird {value}", "x": 1}`;
    expect(extractJson(text)).toEqual({ label: "weird {value}", x: 1 });
  });

  it("respects escaped quotes inside strings", () => {
    const text = `{"q": "he said \\"hi\\""}`;
    expect(extractJson(text)).toEqual({ q: 'he said "hi"' });
  });

  it("throws on malformed JSON rather than guessing", () => {
    expect(() => extractJson("not json at all")).toThrow();
  });

  it("throws when there is no closing brace", () => {
    expect(() => extractJson(`{"oops": 1`)).toThrow();
  });
});
