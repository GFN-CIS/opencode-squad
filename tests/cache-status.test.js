import { expect, test } from "vitest";
import { formatCacheStatus } from "../src/cache-status.js";

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

test("formatCacheStatus is honest about an unpublished TTL instead of guessing", () => {
  const now = 1_000_000;
  const s = formatCacheStatus({
    taskId: "ses_xyz",
    providerModelId: "alibaba-token-plan/qwen3.7-max",
    lastHitMs: now - 30_000,
    // ttlSeconds intentionally omitted
    now,
  });
  expect(s).toContain("isn't published — judge for yourself");
  expect(s).not.toContain("likely still warm");
  expect(s).not.toContain("likely cold");
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
