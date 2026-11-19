import { describe, expect, test } from "vitest";
import {
  estimateContextTokens,
  formatContextSize,
  formatLocalDateTime,
  formatThousands,
  indexModelCatalog,
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

// The host's model catalog (OpenCode 2 `app.models`): a flat list of
// {id, providerID, limit, variants:[{id, settings}]}. One group covers the raw
// host shape, a bare id shared by two providers, and a model with no variants.
describe("indexModelCatalog", () => {
  test("keys limits by provider/model and by bare id; the first provider keeps a shared bare id", () => {
    const { limits } = indexModelCatalog([
      { providerID: "anthropic", id: "claude-opus-4-7", limit: { context: 1000000 } },
      {
        providerID: "zai",
        id: "glm-5.3",
        limit: { context: 200000, output: 32000 },
        variants: [{ id: "low", settings: { reasoningEffort: "low" } }],
      },
      { providerID: "other", id: "glm-5.3", limit: { context: 1 } }, // bare id: first wins
      { providerID: "anthropic", id: "broken" },
    ]);
    expect(limits).toEqual({
      "anthropic/claude-opus-4-7": 1000000,
      "claude-opus-4-7": 1000000,
      "zai/glm-5.3": 200000,
      "glm-5.3": 200000,
      "other/glm-5.3": 1,
    });
  });

  test("reads the variant names opencode itself accepts", () => {
    const { variants } = indexModelCatalog([
      // The raw host shape: [{id, settings}].
      {
        providerID: "zai",
        id: "glm-5.3",
        variants: [
          { id: "low", settings: { reasoningEffort: "low" } },
          { id: "max", settings: { reasoningEffort: "max" } },
        ],
      },
      // A model with no usable variant knob reports an empty set, which must stay
      // distinguishable from "we could not look it up".
      { providerID: "opencode", id: "big-pickle", limit: { context: 128000 }, variants: [] },
      { providerID: "zai-coding-plan", id: "glm-5.3", variants: ["low", "high", "max"] },
      { providerID: "p", id: "keyed", variants: { low: {}, high: {} } },
      { providerID: "p", id: "none" },
    ]);
    expect(variants).toEqual({
      "zai/glm-5.3": ["low", "max"],
      "opencode/big-pickle": [],
      "zai-coding-plan/glm-5.3": ["low", "high", "max"],
      "p/keyed": ["low", "high"],
      "p/none": [],
    });
  });

  test("survives a missing catalog and junk entries without inventing any", () => {
    for (const models of [undefined, null, [], [null, { id: "m" }, { providerID: "p" }]]) {
      expect(indexModelCatalog(models)).toEqual({ limits: {}, variants: {} });
    }
  });
});

test("token formatters: context windows scale to M, counts stay in thousands", () => {
  expect(formatContextSize(200_000)).toBe("200k");
  expect(formatContextSize(1_000_000)).toBe("1M");
  expect(formatContextSize(1_048_576)).toBe("1M");
  expect(formatContextSize(1_500_000)).toBe("1.5M");
  expect(formatThousands(42_400)).toBe("42k");
  expect(formatThousands(1_500_000)).toBe("1500k");
});
