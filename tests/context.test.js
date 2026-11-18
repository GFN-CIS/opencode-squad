import { expect, test } from "vitest";
import {
  buildLimitMap,
  buildVariantMap,
  estimateContextTokens,
  formatLocalDateTime,
} from "../src/context.js";

test("estimate returns null before any assistant reply", () => {
  expect(estimateContextTokens([{ info: { role: "user" }, parts: [] }])).toBe(null);
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
        tokens: {
          total: 20507,
          input: 3,
          output: 30,
          reasoning: 0,
          cache: { read: 0, write: 20474 },
        },
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

test("buildVariantMap reads the variant names opencode itself accepts", () => {
  const map = buildVariantMap([
    {
      id: "anthropic",
      // Keyed object of per-variant settings — the shape opencode serves.
      models: { "claude-haiku-4-5": { variants: { high: {}, max: {} } } },
    },
    // A model with reasoning but no usable variant knob reports an empty set,
    // which must stay distinguishable from "we could not look it up".
    { id: "alibaba-token-plan", models: { "qwen3.7-max": { variants: {} } } },
    { id: "zai-coding-plan", models: { "glm-5.3": { variants: ["low", "high", "max"] } } },
  ]);
  expect(map["anthropic/claude-haiku-4-5"]).toEqual(["high", "max"]);
  expect(map["alibaba-token-plan/qwen3.7-max"]).toEqual([]);
  expect(map["zai-coding-plan/glm-5.3"]).toEqual(["low", "high", "max"]);
});

test("buildVariantMap survives junk without inventing entries", () => {
  expect(buildVariantMap(null)).toEqual({});
  expect(buildVariantMap([{ models: { "a/b": {} } }])).toEqual({}); // no provider id
  expect(buildVariantMap([{ id: "p", models: { m: {} } }])).toEqual({ "p/m": [] });
});
