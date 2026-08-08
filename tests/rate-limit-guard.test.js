import { test, expect } from "bun:test";
import {
  normalizeGuardConfig,
  isGuardedRetry,
  isGuardedTerminalError,
  initGuardState,
  evaluateRetry,
  formatGuardNote,
} from "../src/rate-limit-guard.js";

test("normalizeGuardConfig fills in defaults", () => {
  const cfg = normalizeGuardConfig();
  expect(cfg.enabled).toBe(true);
  expect(cfg.retry_on_errors).toEqual([429]);
  expect(cfg.retryable_error_patterns).toEqual(["rate.?limit", "usage.?limit", "quota"]);
  expect(cfg.max_wait_seconds).toBe(3600);
  expect(cfg.max_cumulative_seconds).toBe(3600);
});

test("normalizeGuardConfig honors overrides, ignores malformed arrays", () => {
  const cfg = normalizeGuardConfig({
    max_wait_seconds: 60,
    retry_on_errors: "not-an-array",
    retryable_error_patterns: ["overloaded"],
  });
  expect(cfg.max_wait_seconds).toBe(60);
  expect(cfg.retry_on_errors).toEqual([429]); // fell back to default
  expect(cfg.retryable_error_patterns).toEqual(["overloaded"]);
});

test("isGuardedRetry matches on message pattern", () => {
  const cfg = normalizeGuardConfig();
  expect(isGuardedRetry({ message: "Usage limit reached, resets in 7 days" }, cfg)).toBe(true);
  expect(isGuardedRetry({ message: "Provider is overloaded" }, cfg)).toBe(false);
});

test("isGuardedRetry matches on action.reason/message when message alone doesn't match", () => {
  const cfg = normalizeGuardConfig();
  const status = { message: "Go limit reached", action: { reason: "account_rate_limit", message: "quota exceeded" } };
  expect(isGuardedRetry(status, cfg)).toBe(true);
});

test("isGuardedRetry matches on cached status code even with unrelated message text", () => {
  const cfg = normalizeGuardConfig();
  expect(isGuardedRetry({ message: "Provider is overloaded" }, cfg, 429)).toBe(true);
  expect(isGuardedRetry({ message: "Provider is overloaded" }, cfg, 503)).toBe(false);
});

test("isGuardedRetry falls back to substring match on an invalid regex pattern", () => {
  const cfg = normalizeGuardConfig({ retryable_error_patterns: ["rate[limit"] }); // invalid regex
  expect(isGuardedRetry({ message: "hit a rate[limit wall" }, cfg)).toBe(true);
  expect(isGuardedRetry({ message: "unrelated failure" }, cfg)).toBe(false);
});

test("evaluateRetry: single wait past threshold triggers immediately, no waiting", () => {
  const cfg = normalizeGuardConfig({ max_wait_seconds: 3600 });
  const state = initGuardState();
  const now = 1_000_000;
  const weekMs = 7 * 24 * 3600 * 1000;
  const result = evaluateRetry(
    state,
    { attempt: 1, message: "usage limit reached", next: now + weekMs },
    cfg,
    undefined,
    now,
  );
  expect(result).toEqual({ trigger: true, reason: "single_wait", waitMs: weekMs, cumulativeMs: weekMs });
});

test("evaluateRetry: short waits accumulate until cumulative threshold trips", () => {
  const cfg = normalizeGuardConfig({ max_wait_seconds: 3600, max_cumulative_seconds: 3600 });
  const state = initGuardState();
  const now = 1_000_000;
  const tenMinMs = 10 * 60 * 1000;

  // 5 retries of 10 minutes each = 50 min, still under the 60 min cumulative cap.
  for (let i = 0; i < 5; i++) {
    const r = evaluateRetry(
      state,
      { attempt: i + 1, message: "rate limit hit", next: now + tenMinMs },
      cfg,
      undefined,
      now,
    );
    expect(r).toEqual({ trigger: false });
  }
  expect(state.cumulativeMs).toBe(5 * tenMinMs);

  // 6th retry brings cumulative to exactly 60 min — not yet past the threshold.
  const r6 = evaluateRetry(
    state,
    { attempt: 6, message: "rate limit hit", next: now + tenMinMs },
    cfg,
    undefined,
    now,
  );
  expect(r6.trigger).toBe(false);

  // 7th retry pushes cumulative past 60 min -> trigger, reason "cumulative".
  const r7 = evaluateRetry(
    state,
    { attempt: 7, message: "rate limit hit", next: now + tenMinMs },
    cfg,
    undefined,
    now,
  );
  expect(r7.trigger).toBe(true);
  expect(r7.reason).toBe("cumulative");
});

test("evaluateRetry: non-matching retry (e.g. plain 503 overload) is left alone entirely", () => {
  const cfg = normalizeGuardConfig();
  const state = initGuardState();
  const now = 1_000_000;
  const r = evaluateRetry(
    state,
    { attempt: 1, message: "Provider is overloaded", next: now + 999_999_999 },
    cfg,
    undefined,
    now,
  );
  expect(r).toEqual({ trigger: false });
  expect(state.cumulativeMs).toBe(0); // untouched — we didn't even start tracking it
});

test("evaluateRetry: once guarded, further retry events on the same session are ignored", () => {
  const cfg = normalizeGuardConfig({ max_wait_seconds: 10 });
  const state = initGuardState();
  const now = 1_000_000;
  const first = evaluateRetry(state, { attempt: 1, message: "rate limit", next: now + 60_000 }, cfg, undefined, now);
  expect(first.trigger).toBe(true);
  state.guarded = true; // caller marks this after acting on the trigger

  const second = evaluateRetry(state, { attempt: 2, message: "rate limit", next: now + 60_000 }, cfg, undefined, now);
  expect(second).toEqual({ trigger: false });
});

test("formatGuardNote: single_wait reason names the announced wait and instructs a model switch", () => {
  const text = formatGuardNote({
    model: "openai/gpt-5.5",
    provider: "openai",
    reason: "single_wait",
    waitMs: 7 * 24 * 3600 * 1000,
    cumulativeMs: 7 * 24 * 3600 * 1000,
    description: "audit MR 88",
  });
  expect(text).toContain("RATE LIMIT GUARD");
  expect(text).toContain("openai/gpt-5.5");
  expect(text).toContain("audit MR 88");
  expect(text).toContain("7d");
  expect(text).toContain("Pick a different grunt/drill");
  expect(text.toLowerCase()).not.toContain("task failed"); // must not read like a hard failure
});

test("formatGuardNote: cumulative reason names accumulated wait, not a single announced one", () => {
  const text = formatGuardNote({
    model: "openai/gpt-5.3-codex",
    provider: "openai",
    reason: "cumulative",
    waitMs: 30_000,
    cumulativeMs: 65 * 60 * 1000,
  });
  expect(text).toContain("accumulated");
  expect(text).toContain("1h");
});

// Real-world case: opencode's own retryable() never classifies "token-plan
// quota has been exhausted" as retryable (it matches none of opencode's
// RETRYABLE_MESSAGE_PATTERNS), so no session.status retry event ever fires —
// the call just fails/gets cancelled on the spot with no warning signal at
// all. isGuardedTerminalError is what catches this case after the fact.
test("isGuardedTerminalError matches a real quota-exhausted provider message", () => {
  const cfg = normalizeGuardConfig();
  expect(isGuardedTerminalError("AI_APICallError: Your token-plan quota has been exhausted.", cfg)).toBe(true);
  expect(isGuardedTerminalError("AI_APICallError: connection reset", cfg)).toBe(false);
});

test("isGuardedTerminalError matches on cached status code even if the text doesn't match", () => {
  const cfg = normalizeGuardConfig();
  expect(isGuardedTerminalError("some opaque provider error", cfg, 429)).toBe(true);
  expect(isGuardedTerminalError("some opaque provider error", cfg, 500)).toBe(false);
});

test("formatGuardNote: terminal_error reason explains a failure the guard never had a chance to abort", () => {
  const text = formatGuardNote({
    model: "alibaba-token-plan/qwen3.8-max",
    provider: "alibaba-token-plan",
    reason: "terminal_error",
    errorText: "Your token-plan quota has been exhausted.",
    description: "Recon tunstrap issue 14 fix",
  });
  expect(text).toContain("RATE LIMIT GUARD");
  expect(text).toContain("alibaba-token-plan/qwen3.8-max");
  expect(text).toContain("quota has been exhausted");
  expect(text).toContain("Recon tunstrap issue 14 fix");
  expect(text).toContain("Pick a different grunt/drill");
});
