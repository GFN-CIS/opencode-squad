import { expect, test } from "vitest";
import {
  ASSUMED_CACHE_TTL_SECONDS,
  formatCacheStatus,
  resolveCacheTtl,
} from "../src/cache-status.js";

test("formatCacheStatus reports still-warm when age is under the published TTL", () => {
  const now = 1_000_000;
  const s = formatCacheStatus({
    taskId: "ses_abc123",
    providerModelId: "anthropic/claude-sonnet-5",
    lastHitMs: now - 60_000, // 60s ago
    ttlSeconds: 300, // 5 min
    now,
  });
  expect(s).toContain("[CACHE STATUS]");
  expect(s).toContain("task_id=ses_abc123");
  expect(s).toContain("anthropic/claude-sonnet-5");
  expect(s).toContain("last provider hit ~1m ago");
  expect(s).toContain("likely still warm");
  expect(s).toContain("Pass task_id to continue");
});

test("formatCacheStatus reports likely-cold once age exceeds the published TTL", () => {
  const now = 1_000_000;
  const s = formatCacheStatus({
    taskId: "ses_abc123",
    providerModelId: "anthropic/claude-sonnet-5",
    lastHitMs: now - 400_000, // 400s ago
    ttlSeconds: 300,
    now,
  });
  expect(s).toContain("last provider hit ~6m 40s ago");
  expect(s).toContain("likely cold by now");
});

test("formatCacheStatus: age exactly equal to TTL reads as cold, not warm (strictly less-than)", () => {
  const now = 1_000_000;
  const s = formatCacheStatus({
    taskId: "ses_boundary",
    providerModelId: "anthropic/claude-sonnet-5",
    lastHitMs: now - 300_000, // exactly 300s ago
    ttlSeconds: 300,
    now,
  });
  expect(s).toContain("likely cold by now");
  expect(s).not.toContain("likely still warm");
});

test("formatCacheStatus labels an assumed TTL as assumed instead of passing it off as published", () => {
  // The honesty guarantee in its current form. A provider that publishes no
  // TTL still gets a number (silence read as "cache lives forever"), but the
  // wording must let the orchestrator tell a default from a fact.
  const now = 1_000_000;
  const s = formatCacheStatus({
    taskId: "ses_xyz",
    providerModelId: "alibaba-token-plan/qwen3.7-max",
    lastHitMs: now - 30_000,
    // ttlSeconds intentionally omitted -> resolved from the provider
    now,
  });
  expect(s).toContain("no cache TTL published for this provider");
  expect(s).toContain("assuming a conservative ~5m floor");
  expect(s).toContain("likely still warm"); // 30s < 300s
  expect(s).not.toContain("published cache TTL");
});

test("formatCacheStatus reports a published TTL as published", () => {
  const now = 1_000_000;
  const s = formatCacheStatus({
    taskId: "ses_pub",
    providerModelId: "anthropic/claude-opus-5",
    lastHitMs: now - 30_000,
    now,
  });
  expect(s).toContain("published cache TTL ~5m");
  expect(s).not.toContain("assuming a conservative");
});

test("formatCacheStatus applies the assumed floor to an unknown provider, not silence", () => {
  const now = 1_000_000;
  const s = formatCacheStatus({
    taskId: "ses_new",
    providerModelId: "some-new-provider/some-model",
    lastHitMs: now - 600_000, // 10 min
    now,
  });
  expect(s).toContain("likely cold by now");
  expect(s).not.toContain("judge for yourself");
});

test("formatCacheStatus never reports a negative age (clock skew safety)", () => {
  const now = 1_000_000;
  const s = formatCacheStatus({
    taskId: "ses_abc",
    providerModelId: "openai/gpt-5.6-terra",
    lastHitMs: now + 5_000, // "in the future" — shouldn't happen, but don't print -5s
    ttlSeconds: 1800,
    now,
  });
  expect(s).toContain("last provider hit ~0s ago");
});

test("resolveCacheTtl returns published figures for providers that publish one", () => {
  expect(resolveCacheTtl("anthropic")).toEqual({ seconds: 300, source: "published" });
  // Not flattened to 300: a flat default would call a warm 30-min OpenAI
  // session cold.
  expect(resolveCacheTtl("openai")).toEqual({ seconds: 1800, source: "published" });
});

test("resolveCacheTtl falls back to the assumed floor, always with a number", () => {
  for (const p of ["alibaba-token-plan", "zai-coding-plan", "totally-unknown", undefined, ""]) {
    expect(resolveCacheTtl(p)).toEqual({
      seconds: ASSUMED_CACHE_TTL_SECONDS,
      source: "assumed",
    });
  }
  expect(ASSUMED_CACHE_TTL_SECONDS).toBe(300);
});

test("resolveCacheTtl is not fooled by inherited Object.prototype keys", () => {
  expect(resolveCacheTtl("constructor")).toEqual({ seconds: 300, source: "assumed" });
  expect(resolveCacheTtl("toString")).toEqual({ seconds: 300, source: "assumed" });
});

test("formatCacheStatus reports session size and the per-step re-read cost", () => {
  const now = 1_000_000;
  const s = formatCacheStatus({
    taskId: "ses_big",
    providerModelId: "anthropic/claude-opus-5",
    lastHitMs: now - 60_000,
    contextTokens: 944_633,
    contextLimit: 1_000_000,
    now,
  });
  expect(s).toContain("~945k / 1000k (94%)");
  expect(s).toContain("re-reads all of that on every step");
  // The estimateContextTokens caveat must travel with the number.
  expect(s).toContain("right after a compaction this still reads high");
});

test("formatCacheStatus reports size without a percentage when the window is unknown", () => {
  const now = 1_000_000;
  const s = formatCacheStatus({
    taskId: "ses_nolimit",
    providerModelId: "anthropic/claude-opus-5",
    lastHitMs: now - 60_000,
    contextTokens: 120_000,
    now,
  });
  expect(s).toContain("~120k as of its last completed turn");
  expect(s).not.toContain("%)");
});

test("formatCacheStatus omits the size clause entirely when usage is unavailable", () => {
  const now = 1_000_000;
  for (const contextTokens of [undefined, 0, -1]) {
    const s = formatCacheStatus({
      taskId: "ses_nousage",
      providerModelId: "anthropic/claude-opus-5",
      lastHitMs: now - 60_000,
      contextTokens,
      now,
    });
    // Degrades to the plain note rather than suppressing it.
    expect(s).toContain("[CACHE STATUS]");
    expect(s).toContain("published cache TTL ~5m");
    expect(s).not.toContain("Its context is");
  }
});

test("formatCacheStatus renders both the relative age and the absolute wall clock", () => {
  const now = 1_000_000;
  const s = formatCacheStatus({
    taskId: "ses_when",
    providerModelId: "anthropic/claude-opus-5",
    lastHitMs: now - 17 * 60_000,
    lastHitAtText: "2026-08-27 13:25:16 (Europe/Moscow)",
    now,
  });
  // Relative reads at completion time; absolute stays usable a turn later,
  // when the orchestrator recomputes the gap against its bootstrap clock.
  expect(s).toContain("last provider hit ~17m ago (2026-08-27 13:25:16 (Europe/Moscow))");
  expect(s).toContain("model anthropic/claude-opus-5");
});

test("formatCacheStatus degrades to relative-only when the timestamp is unavailable", () => {
  const now = 1_000_000;
  for (const lastHitAtText of [undefined, ""]) {
    const s = formatCacheStatus({
      taskId: "ses_nots",
      providerModelId: "anthropic/claude-opus-5",
      lastHitMs: now - 17 * 60_000,
      lastHitAtText,
      now,
    });
    expect(s).toContain("last provider hit ~17m ago, model anthropic/claude-opus-5");
    expect(s).toContain("likely cold by now");
  }
});
