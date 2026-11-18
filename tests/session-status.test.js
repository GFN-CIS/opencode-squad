// Suite: src/session-status.js — the squad_session report. Covers reading a
// V2 session (newest provider contact, running vs finished, empty or cut-off
// last result, context size) and the verdicts with the arithmetic done:
// warm for N more seconds, cold for N seconds, probably running.
// Not covered: the tool wiring (plugin-entry suite).
// Run: npx vitest run tests/session-status.test.js

import { describe, expect, test } from "vitest";
import {
  formatNow,
  formatOwnStatus,
  formatSessionStatus,
  requestedSessions,
  sessionFacts,
} from "../src/session-status.js";

const T0 = Date.UTC(2026, 10, 18, 9, 0, 0);
const usage = (read) => ({ input: 1, output: 50, reasoning: 10, cache: { read, write: 100 } });
const msg = (type, extra = {}) => ({ type, time: { created: T0 }, ...extra });
const sonnet = { providerID: "anthropic", id: "claude-sonnet-5-5" };

const finished = [
  msg("user"),
  msg("assistant", {
    agent: "grunt-anthropic-claude-sonnet-5-5",
    model: sonnet,
    time: { created: T0, completed: T0 + 5_000 },
    finish: "stop",
    tokens: usage(29_900),
    content: [{ type: "text", text: "done: found the VM" }],
  }),
];

describe("sessionFacts", () => {
  test("reads the newest provider contact, model, size and a clean finish", () => {
    const f = sessionFacts(finished);
    expect(f).toMatchObject({
      agent: "grunt-anthropic-claude-sonnet-5-5",
      model: "anthropic/claude-sonnet-5-5",
      lastHitMs: T0,
      running: false,
      finish: "stop",
      resultEmpty: false,
    });
    expect(f.contextTokens).toBeGreaterThan(29_000);
  });

  test("an unfinished newest step reads as running; the outcome comes from the last finished one", () => {
    const f = sessionFacts([
      ...finished,
      msg("assistant", { model: sonnet, time: { created: T0 + 60_000 }, content: [] }),
    ]);
    expect(f.running).toBe(true);
    expect(f.lastHitMs).toBe(T0 + 60_000);
    expect(f.finish).toBe("stop");
  });

  test("an idle record after an unfinished step means it stopped, not running", () => {
    const f = sessionFacts([
      ...finished,
      msg("assistant", { model: sonnet, time: { created: T0 + 60_000 }, content: [] }),
      { type: "idle", time: { created: T0 + 61_000 }, outcome: "interrupted" },
    ]);
    expect(f.running).toBe(false);
  });

  test("a finished step with no text is an empty result", () => {
    const f = sessionFacts([
      msg("assistant", {
        model: sonnet,
        time: { created: T0, completed: T0 + 1 },
        finish: "length",
        tokens: { output: 9, reasoning: 31_991 },
        content: [{ type: "reasoning", text: "drafts" }],
      }),
    ]);
    expect(f).toMatchObject({ resultEmpty: true, finish: "length", reasoningTokens: 31_991 });
  });

  test("tolerates an empty or missing message list", () => {
    expect(sessionFacts(undefined)).toMatchObject({ lastHitMs: null, running: false, model: null });
  });
});

describe("formatSessionStatus", () => {
  const facts = sessionFacts(finished);
  const report = (now, extra = {}) =>
    formatSessionStatus({ sessionID: "ses_x", facts, now, ...extra });

  test("warm: says how many seconds are left, with the TTL and its source", () => {
    const s = report(T0 + 110_000, { contextLimit: 1_000_000 });
    expect(s.startsWith("session ses_x")).toBe(true);
    expect(s).toContain(
      "session ses_x (grunt-anthropic-claude-sonnet-5-5, anthropic/claude-sonnet-5-5)",
    );
    expect(s).toContain("cache: WARM — expires in 190 s");
    expect(s).toContain("TTL 300 s, published");
    expect(s).toMatch(/context: ~30k \/ 1000k \(3%\)/);
    expect(s).not.toContain("[TASK OUTCOME]");
  });

  test("cold: says how long ago it expired; exactly at the TTL is already cold", () => {
    expect(report(T0 + 300_000)).toContain("cache: COLD — expired 0 s ago");
    expect(report(T0 + 1_120_000)).toContain("cache: COLD — expired 820 s ago");
  });

  test("a TTL from model_data.json overrides the provider's", () => {
    const s = report(T0 + 400_000, { ttlSeconds: 3600 });
    expect(s).toContain("cache: WARM — expires in 3200 s");
    expect(s).toContain("set in model_data.json");
  });

  test("running: no cache verdict, points at the <subagent> message", () => {
    const s = formatSessionStatus({
      sessionID: "ses_x",
      facts: { ...facts, running: true },
      now: T0 + 20_000,
    });
    expect(s).toContain("probably RUNNING — its current step started 20 s ago");
    expect(s).not.toContain("cache:");
  });

  test("an empty truncated result carries the max_tokens diagnosis", () => {
    const s = formatSessionStatus({
      sessionID: "ses_x",
      facts: {
        ...facts,
        finish: "length",
        resultEmpty: true,
        outputTokens: 9,
        reasoningTokens: 31_991,
      },
      now: T0 + 1_000,
    });
    expect(s).toContain("[TASK OUTCOME] sessionID=ses_x");
    expect(s).toContain("hit max_tokens");
  });

  test("a session that never reached its provider has nothing to reuse", () => {
    const s = formatSessionStatus({
      sessionID: "ses_new",
      facts: sessionFacts([msg("user")]),
      now: T0,
    });
    expect(s).toContain("no cache to reuse");
  });

  test("never reports a negative age (clock skew)", () => {
    expect(report(T0 - 5_000)).toContain("expires in 300 s (last provider request 0 s ago");
  });
});

test("formatOwnStatus: the clock and the caller's own context", () => {
  const s = formatOwnStatus({
    contextTokens: 98_000,
    contextLimit: 1_000_000,
    now: T0,
    timeZone: "UTC",
  });
  expect(s).toContain("now: 2026-11-18 09:00:00 (UTC)");
  expect(s).toContain("your context: ~98k / 1000k (10%)");
  expect(formatOwnStatus({ now: T0, timeZone: "UTC" })).not.toContain("your context");
});

test("formatNow stamps the wall clock in the given zone", () => {
  expect(formatNow(T0, "UTC")).toBe("now: 2026-11-18 09:00:00 (UTC)");
});

test("requestedSessions takes an array or one bare id, deduplicated", () => {
  expect(requestedSessions({ sessionIDs: ["a", " b ", "a", ""] })).toEqual(["a", "b"]);
  expect(requestedSessions({ sessionIDs: "a" })).toEqual(["a"]);
  expect(requestedSessions({ sessionID: "c" })).toEqual(["c"]);
  expect(requestedSessions({})).toEqual([]);
  expect(requestedSessions(undefined)).toEqual([]);
});
