import { describe, expect, it } from "vitest";

import { formatCompactReport, pickCompactionModel, splitModelId } from "../src/compact.js";

const MODELS = {
  "anthropic/claude-opus-5": { price_blended: 10 },
  "anthropic/claude-haiku-4-5": { price_blended: 1.1 },
  "openai/gpt-5.6-luna": { price_blended: 0.4 },
  "zai-coding-plan/glm-5.3": { price_blended: 0.9, billing: "subscription" },
};

describe("pickCompactionModel", () => {
  it("prefers a flat-rate model — its marginal cost is the point", () => {
    const got = pickCompactionModel({ models: MODELS, available: Object.keys(MODELS) });
    expect(got.id).toBe("zai-coding-plan/glm-5.3");
    expect(got.why).toContain("subscription");
  });

  it("falls to the cheapest priced model when nothing is flat-rate", () => {
    const { "zai-coding-plan/glm-5.3": _flat, ...metered } = MODELS;
    const got = pickCompactionModel({ models: metered, available: Object.keys(metered) });
    expect(got.id).toBe("openai/gpt-5.6-luna");
    expect(got.why).toContain("$0.4/M");
  });

  it("only considers models the squad actually has an agent for", () => {
    const got = pickCompactionModel({
      models: MODELS,
      available: ["anthropic/claude-opus-5", "anthropic/claude-haiku-4-5"],
    });
    expect(got.id).toBe("anthropic/claude-haiku-4-5");
  });

  it("an explicit model wins over everything", () => {
    const got = pickCompactionModel({
      explicit: "anthropic/claude-opus-5",
      models: MODELS,
      available: Object.keys(MODELS),
    });
    expect(got).toEqual({ id: "anthropic/claude-opus-5", why: "explicitly requested" });
  });

  it("falls back to the session's own model only when there is no pricing at all", () => {
    const got = pickCompactionModel({ models: {}, sessionModel: "anthropic/claude-sonnet-5" });
    expect(got.id).toBe("anthropic/claude-sonnet-5");
    expect(got.why).toContain("fell back");
  });

  it("returns null when nothing usable was supplied, rather than a half-id", () => {
    expect(pickCompactionModel({})).toBeNull();
    expect(pickCompactionModel({ explicit: "not-an-id", models: {} })).toBeNull();
    expect(pickCompactionModel({ sessionModel: "trailing/" })).toBeNull();
  });
});

describe("splitModelId", () => {
  it("splits on the first slash so a model id may contain more", () => {
    expect(splitModelId("openai/gpt-5.6-luna")).toEqual({
      providerID: "openai",
      modelID: "gpt-5.6-luna",
    });
    expect(splitModelId("a/b/c")).toEqual({ providerID: "a", modelID: "b/c" });
  });

  it("rejects anything that is not provider/model", () => {
    for (const bad of ["", "nope", "/leading", "trailing/", undefined]) {
      expect(splitModelId(bad)).toBeNull();
    }
  });
});

describe("formatCompactReport", () => {
  it("states the reduction and the cache consequence", () => {
    const out = formatCompactReport({
      taskId: "ses_abc",
      agent: "grunt-anthropic-claude-sonnet-5",
      before: 596_000,
      after: 48_000,
      model: "zai-coding-plan/glm-5.3",
      why: "flat-rate (subscription) — ~$0 marginal cost for the pass",
    });
    expect(out).toContain("~596k → ~48k tokens");
    expect(out).toContain("−92%");
    expect(out).toContain("COLD");
    expect(out).not.toContain("NOTE:");
  });

  it("says so when compaction did not shrink anything", () => {
    const out = formatCompactReport({
      taskId: "ses_abc",
      before: 40_000,
      after: 41_000,
      model: "m/x",
      why: "w",
    });
    expect(out).toContain("(no reduction)");
  });

  it("marks a timed-out call as stale and states no reduction it cannot know", () => {
    // The caller does not read the size after a timeout — the compaction is
    // still running — so the report must not print a percentage either.
    const out = formatCompactReport({
      taskId: "ses_abc",
      before: 500_000,
      model: "m/x",
      why: "w",
      timedOut: true,
    });
    expect(out).toContain("did not return in time");
    expect(out).toContain("could not be read");
    expect(out).not.toMatch(/[−-]\d+%/);
  });

  it("degrades when the sizes could not be read", () => {
    expect(formatCompactReport({ taskId: "s", model: "m/x", why: "w" })).toContain("size unknown");
    expect(formatCompactReport({ taskId: "s", before: 1000, model: "m/x", why: "w" })).toContain(
      "could not be read",
    );
  });
});
