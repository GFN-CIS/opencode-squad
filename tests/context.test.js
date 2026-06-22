import { test, expect } from "bun:test";
import {
  estimateContextTokens,
  formatContextLine,
  buildLimitMap,
  resolveOrchestratorModel,
  formatLocalDateTime,
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

test("estimate reports the latest turn's count (no suppression, no thresholds)", () => {
  // An earlier turn was huge; the latest is small. We report the latest as-is.
  const messages = [
    { info: { role: "assistant", tokens: { total: 580000 } } },
    { info: { role: "user" } },
    {
      info: {
        role: "assistant",
        modelID: "claude-opus-4-8",
        providerID: "anthropic",
        tokens: { total: 24000 },
      },
    },
  ];
  const r = estimateContextTokens(messages);
  expect(r).toEqual({ used: 24000, modelID: "claude-opus-4-8", providerID: "anthropic" });
});

test("format returns null when there is no usage", () => {
  expect(formatContextLine(null, 200000)).toBe(null);
  expect(formatContextLine(0, 200000)).toBe(null);
});

test("format states the facts with no threshold, judgment, or caveats", () => {
  // 58% of a 1M window must NOT carry any "prefer delegating" instruction —
  // the model decides; we report only the number. No compaction caveat either:
  // it would hand the model an excuse to dismiss the figure.
  const out = formatContextLine(580000, 1000000);
  expect(out.startsWith(CONTEXT_MARKER)).toBe(true);
  expect(out).toContain("(58%)");
  expect(out.toUpperCase()).not.toContain("PREFER DELEGAT");
  expect(out.toLowerCase()).not.toContain("compaction");
});

test("format shows percent/size for a small fill too", () => {
  const out = formatContextLine(40000, 200000);
  expect(out).toContain("(20%)");
  expect(out.toUpperCase()).not.toContain("PREFER DELEGATING");
});

test("format degrades gracefully without a known limit", () => {
  const out = formatContextLine(50000, null);
  expect(out).toContain("~50k tokens");
  expect(out).not.toContain("%");
});

test("resolveOrchestratorModel returns provider/model of the latest assistant", () => {
  const messages = [
    { info: { role: "assistant", modelID: "claude-opus-4-5", providerID: "anthropic" } },
    { info: { role: "user" } },
    { info: { role: "assistant", modelID: "claude-opus-4-7", providerID: "anthropic" } },
    { info: { role: "user" } },
  ];
  expect(resolveOrchestratorModel(messages)).toBe("anthropic/claude-opus-4-7");
  // No assistant yet -> null (caller uses the configured fallback).
  expect(resolveOrchestratorModel([{ info: { role: "user" } }])).toBe(null);
  expect(resolveOrchestratorModel(undefined)).toBe(null);
});

test("formatLocalDateTime renders ISO-like time with the zone", () => {
  const d = new Date("2026-06-19T08:49:52Z");
  expect(formatLocalDateTime(d, "UTC")).toBe("2026-06-19 08:49:52 (UTC)");
  // A non-UTC zone shifts the clock and is labelled.
  const moscow = formatLocalDateTime(d, "Europe/Moscow");
  expect(moscow).toContain("11:49:52");
  expect(moscow).toContain("(Europe/Moscow)");
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
