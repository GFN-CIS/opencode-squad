import { test, expect } from "bun:test";
import {
  estimateContextTokens,
  formatContextLine,
  buildLimitMap,
  CONTEXT_MARKER,
} from "../src/context.js";

test("estimate returns null before any assistant reply", () => {
  expect(estimateContextTokens([{ info: { role: "user" }, parts: [] }])).toBe(
    null,
  );
  expect(estimateContextTokens([])).toBe(null);
  expect(estimateContextTokens(undefined)).toBe(null);
});

test("estimate prefers the live `total` field (which already sums cache)", () => {
  // Shape from the real transform payload: input is uncached-only, the bulk is
  // in cache.*, and `total` sums everything.
  const messages = [
    { info: { role: "user" } },
    {
      info: {
        role: "assistant",
        modelID: "claude-opus-4-7",
        providerID: "anthropic",
        tokens: { total: 20507, input: 3, output: 30, reasoning: 0, cache: { read: 0, write: 20474 } },
      },
    },
    { info: { role: "user" } },
  ];
  const r = estimateContextTokens(messages);
  expect(r).toEqual({ used: 20507, modelID: "claude-opus-4-7", providerID: "anthropic" });
});

test("estimate falls back to input+output+reasoning+cache when total absent", () => {
  const messages = [
    {
      info: {
        role: "assistant",
        tokens: { input: 3, output: 30, reasoning: 2, cache: { read: 100, write: 20000 } },
      },
    },
  ];
  // Must NOT be `input` alone (3) — that under-reports by orders of magnitude.
  expect(estimateContextTokens(messages).used).toBe(20135);
});

test("format returns null when there is no usage", () => {
  expect(formatContextLine(null, 200000)).toBe(null);
  expect(formatContextLine(0, 200000)).toBe(null);
});

test("format shows percent and a nudge past 50%", () => {
  const out = formatContextLine(120000, 200000);
  expect(out.startsWith(CONTEXT_MARKER)).toBe(true);
  expect(out).toContain("~120k / 200k (60%)");
  expect(out.toUpperCase()).toContain("PREFER DELEGATING");
});

test("format omits the nudge below 50%", () => {
  const out = formatContextLine(40000, 200000);
  expect(out).toContain("(20%)");
  expect(out.toUpperCase()).not.toContain("PREFER DELEGATING");
});

test("format degrades gracefully without a known limit", () => {
  const out = formatContextLine(50000, null);
  expect(out).toContain("~50k tokens");
  expect(out).not.toContain("%");
});

test("limit map keys by provider/model and bare model (provider array)", () => {
  const map = buildLimitMap([
    {
      id: "anthropic",
      models: {
        "claude-opus-4-7": { limit: { context: 1000000 } },
        "claude-sonnet-4-6": { limit: { context: 190000 } },
        broken: {},
      },
    },
  ]);
  expect(map["anthropic/claude-opus-4-7"]).toBe(1000000);
  expect(map["claude-opus-4-7"]).toBe(1000000);
  expect(map["claude-sonnet-4-6"]).toBe(190000);
  expect(map.broken).toBeUndefined();
  expect(buildLimitMap(undefined)).toEqual({});
  expect(buildLimitMap([])).toEqual({});
});
