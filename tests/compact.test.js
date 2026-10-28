import { describe, expect, it } from "vitest";

import { formatCompactReport } from "../src/compact.js";

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
