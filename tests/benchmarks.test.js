import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { agenticScore, formatBench, lookupBenchmark, slugCandidates } from "../src/benchmarks.js";

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
    "anthropic/claude-opus-5-5",
    "anthropic/claude-sonnet-5-5",
    "anthropic/claude-haiku-5-5",
    "openai/gpt-6.1-sol",
    "openai/gpt-6-astra",
    "zai/glm-5.3",
  ]) {
    const r = lookupBenchmark(id, snapshot.models);
    expect(r).not.toBeNull();
    expect(typeof r.data.intelligence).toBe("number");
  }
});

test("GLM and Kimi are covered too", () => {
  expect(lookupBenchmark("zai/glm-5.3", snapshot.models)).not.toBeNull();
  expect(lookupBenchmark("moonshotai/kimi-k3-1-pro", snapshot.models)).not.toBeNull();
});

test("snapshot has a meta block and a healthy model count", () => {
  expect(snapshot._meta.source).toContain("artificialanalysis");
  expect(snapshot._meta.intelligence_index).toBe("v5");
  expect(snapshot._meta.model_count).toBeGreaterThanOrEqual(50);
});

test("unknown model returns null", () => {
  expect(lookupBenchmark("acme/not-a-real-model", snapshot.models)).toBeNull();
});

test("agenticScore is terminalbench_v4_0 scaled to 0-100 (v5 era)", () => {
  expect(agenticScore({ agentic: { tau2: 0.94, terminalbench_v4_0: 0.86 } })).toBe(86);
  expect(agenticScore({ agentic: { terminalbench_v4_0: 0.523 } })).toBe(52);
  // tau2 is not part of the aggregate: numeric for only 4/77 v5-scored models
  expect(agenticScore({ agentic: { tau2: 0.98, terminalbench_v4_0: null } })).toBeNull();
  // the pre-v5 terminalbench alone scores nothing either
  expect(agenticScore({ agentic: { terminalbench_v2_1: 0.9 } })).toBeNull();
  expect(agenticScore({ agentic: {} })).toBeNull();
});

test("formatBench is the minimal routing set (intel/code/agentic/$), no speed/details", () => {
  const s = formatBench("openai/gpt-6-astra", snapshot.models);
  expect(s).toContain("AA");
  expect(s).toMatch(/intel \d+/);
  expect(s).toMatch(/code \d+/);
  expect(s).toMatch(/agentic \d+/);
  expect(s).toContain("$");
  expect(s.toLowerCase()).not.toContain("tps");
  expect(s.toLowerCase()).not.toContain("scicode");
  expect(formatBench("acme/nope", snapshot.models)).toBeNull();
});
