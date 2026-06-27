import { test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { slugCandidates, lookupBenchmark } from "../src/benchmarks.js";

const snapshot = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "benchmarks.json"),
    "utf8",
  ),
);

test("slug candidates normalize provider/model and dots", () => {
  expect(slugCandidates("openai/gpt-5.5")).toContain("gpt-5-5");
  expect(slugCandidates("google/gemini-3.1-pro-preview")).toContain("gemini-3-1-pro-preview");
  // anthropic family/size flip both ways
  expect(slugCandidates("anthropic/claude-haiku-4-5")).toContain("claude-4-5-haiku");
  // -fast / dated suffixes stripped
  expect(slugCandidates("anthropic/claude-opus-4-8-fast")).toContain("claude-opus-4-8");
});

test("real roster models resolve in the snapshot", () => {
  for (const id of [
    "anthropic/claude-opus-4-8",
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-haiku-4-5", // needs the flip
    "openai/gpt-5.5",
    "openai/gpt-5.3-codex",
    "google/gemini-3.5-flash",
  ]) {
    const r = lookupBenchmark(id, snapshot.models);
    expect(r).not.toBeNull();
    expect(typeof r.data.intelligence).toBe("number");
  }
});

test("GLM and Kimi are covered too", () => {
  expect(lookupBenchmark("zai/glm-5", snapshot.models)).not.toBeNull();
  expect(lookupBenchmark("moonshotai/kimi-k2-thinking", snapshot.models)).not.toBeNull();
});

test("snapshot has a meta block and a healthy model count", () => {
  expect(snapshot._meta.source).toContain("artificialanalysis");
  expect(snapshot._meta.model_count).toBeGreaterThan(400);
});

test("unknown model returns null", () => {
  expect(lookupBenchmark("acme/not-a-real-model", snapshot.models)).toBeNull();
});
