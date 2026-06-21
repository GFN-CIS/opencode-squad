import { test, expect } from "bun:test";
import {
  estimateContextTokens,
  crudePayloadTokens,
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

test("estimate suppresses the line when a compaction made the count stale", () => {
  // Last recorded turn is huge, but the live payload is tiny -> a compaction
  // happened and 580k is stale. Suppress (null) rather than reporting "60%".
  const messages = [
    {
      info: {
        role: "assistant",
        modelID: "claude-opus-4-8",
        providerID: "anthropic",
        tokens: { total: 580000, cache: { read: 0, write: 0 } },
      },
      parts: [{ type: "text", text: "x".repeat(40) }],
    },
    { info: { role: "user" }, parts: [{ type: "text", text: "ok" }] },
  ];
  expect(estimateContextTokens(messages)).toBe(null);
});

test("estimate keeps the accurate count when the payload is consistent", () => {
  const big = "y".repeat(200000); // crude ~50k, not < 25% of 48k -> no false drop
  const messages = [
    { info: { role: "assistant", tokens: { total: 48000 } }, parts: [{ type: "text", text: big }] },
  ];
  expect(estimateContextTokens(messages).used).toBe(48000);
});

test("crudePayloadTokens counts all parts including tool content", () => {
  const m = [
    {
      parts: [
        { type: "text", text: "a".repeat(400) },
        { type: "tool", state: { output: "b".repeat(400) } },
      ],
    },
  ];
  expect(crudePayloadTokens(m)).toBeGreaterThan(150);
  expect(crudePayloadTokens([])).toBe(0);
  expect(crudePayloadTokens(undefined)).toBe(0);
});

test("format returns null when there is no usage", () => {
  expect(formatContextLine(null, 200000)).toBe(null);
  expect(formatContextLine(0, 200000)).toBe(null);
});

test("nudge keys on remaining headroom, not a flat percentage", () => {
  // 58% of a 1M window = ~420k free: must NOT nudge (the post-compaction gripe).
  const big = formatContextLine(580000, 1000000);
  expect(big.startsWith(CONTEXT_MARKER)).toBe(true);
  expect(big).toContain("(58%)");
  expect(big.toUpperCase()).not.toContain("PREFER DELEGATING");
  // Near-full 1M window -> nudge.
  expect(formatContextLine(900000, 1000000).toUpperCase()).toContain(
    "PREFER DELEGATING",
  );
  // Small window near full -> nudge.
  expect(formatContextLine(170000, 200000).toUpperCase()).toContain(
    "PREFER DELEGATING",
  );
});

test("format shows percent/size and no nudge with ample headroom", () => {
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
