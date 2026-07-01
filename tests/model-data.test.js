import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractModelId,
  discoverSquadModels,
  perfFromBenchmark,
  mergeModelData,
  buildModelData,
  formatPerf,
  readModelData,
  modelsChanged,
} from "../src/model-data.js";

// Minimal AA-shaped snapshot for deterministic perf lookups.
const BENCH = {
  "gpt-5-5": {
    name: "GPT-5.5",
    intelligence: 54.8,
    coding: 74.9,
    agentic: { tau2: 0.9, terminalbench_v2_1: 0.8 },
    price_blended: 11.25,
  },
};

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "squad-md-"));
}

test("extractModelId reads the frontmatter model line only", () => {
  const md = `---\nmode: subagent\nmodel: openai/gpt-5.5\nhidden: true\n---\n\nBody mentions model: anthropic/decoy here.`;
  expect(extractModelId(md)).toBe("openai/gpt-5.5");
});

test("extractModelId returns null when absent", () => {
  expect(extractModelId("---\nmode: subagent\n---\nbody")).toBeNull();
});

test("discoverSquadModels dedupes grunt+drill of one model and ignores others", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "grunt-openai-gpt-5-5.md"), "---\nmodel: openai/gpt-5.5\n---\n");
  fs.writeFileSync(path.join(dir, "drill-openai-gpt-5-5.md"), "---\nmodel: openai/gpt-5.5\n---\n");
  fs.writeFileSync(path.join(dir, "grunt-anthropic-x.md"), "---\nmodel: anthropic/x\n---\n");
  fs.writeFileSync(path.join(dir, "build.md"), "---\nmodel: anthropic/should-ignore\n---\n");
  fs.writeFileSync(path.join(dir, "notes.txt"), "model: nope/nope");
  expect(discoverSquadModels(dir)).toEqual(["anthropic/x", "openai/gpt-5.5"]);
});

test("discoverSquadModels returns [] for a missing dir", () => {
  expect(discoverSquadModels("/no/such/dir/here")).toEqual([]);
});

test("perfFromBenchmark copies indices and the matched aa slug", () => {
  const p = perfFromBenchmark("openai/gpt-5.5", BENCH);
  expect(p.aa_slug).toBe("gpt-5-5");
  expect(p.intelligence).toBe(55);
  expect(p.coding).toBe(75);
  expect(p.agentic).toBe(85);
  expect(p.price_blended).toBe(11.25);
  expect("info" in p).toBe(false); // perf overlay must not carry info
});

test("perfFromBenchmark returns an all-null entry on no AA match", () => {
  const p = perfFromBenchmark("local/unknown-model", BENCH);
  expect(p).toEqual({
    name: null,
    aa_slug: null,
    intelligence: null,
    coding: null,
    agentic: null,
    price_blended: null,
  });
});

test("mergeModelData refreshes perf but preserves info and hand-added fields", () => {
  const existing = {
    models: {
      "openai/gpt-5.5": {
        info: "great at coding",
        myNote: "keep me",
        intelligence: 1, // stale hand-edited perf -> must be overwritten
      },
    },
  };
  const merged = mergeModelData(["openai/gpt-5.5"], BENCH, existing);
  const e = merged["openai/gpt-5.5"];
  expect(e.info).toBe("great at coding"); // preserved
  expect(e.myNote).toBe("keep me"); // arbitrary hand field preserved
  expect(e.intelligence).toBe(55); // perf refreshed, not the stale 1
});

test("mergeModelData gives new models empty info and drops removed ones", () => {
  const existing = { models: { "old/removed": { info: "gone" } } };
  const merged = mergeModelData(["openai/gpt-5.5"], BENCH, existing);
  expect(merged["openai/gpt-5.5"].info).toBe("");
  expect("old/removed" in merged).toBe(false); // not in the squad anymore -> dropped
});

test("buildModelData scans a dir and stamps meta", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "grunt-openai-gpt-5-5.md"), "---\nmodel: openai/gpt-5.5\n---\n");
  const snap = buildModelData(dir, BENCH, {}, "2026-06-30");
  expect(snap._meta.generated).toBe("2026-06-30");
  expect(snap._meta.model_count).toBe(1);
  expect(snap.models["openai/gpt-5.5"].coding).toBe(75);
});

test("formatPerf renders indices plus the info note", () => {
  const s = formatPerf({
    intelligence: 55,
    coding: 75,
    agentic: 85,
    price_blended: 11.25,
    info: "good for coding, weak at long context",
  });
  expect(s).toBe(
    "AA intel 55 · code 75 · agentic 85 · $11.25/M · note: good for coding, weak at long context",
  );
});

test("formatPerf with only a note (no AA match) still surfaces it", () => {
  expect(formatPerf({ intelligence: null, info: "local model" })).toBe("note: local model");
});

test("formatPerf returns null for an empty entry", () => {
  expect(formatPerf({ intelligence: null, info: "" })).toBeNull();
  expect(formatPerf(null)).toBeNull();
});

test("modelsChanged detects real model diffs and ignores rebuild churn", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "grunt-openai-gpt-5-5.md"), "---\nmodel: openai/gpt-5.5\n---\n");
  const first = buildModelData(dir, BENCH, {}, "2026-06-30");
  // rebuild on a later date over the prior output: same models -> no change,
  // so the startup auto-regen must NOT rewrite just because the date moved.
  const second = buildModelData(dir, BENCH, first, "2026-07-15");
  expect(modelsChanged(first, second)).toBe(false);
  // a hand-edited info IS a change worth persisting
  const edited = { models: { ...first.models } };
  edited.models["openai/gpt-5.5"] = { ...edited.models["openai/gpt-5.5"], info: "new note" };
  expect(modelsChanged(first, edited)).toBe(true);
  // a new squad member is a change
  fs.writeFileSync(path.join(dir, "grunt-anthropic-x.md"), "---\nmodel: anthropic/x\n---\n");
  const third = buildModelData(dir, BENCH, second, "2026-07-15");
  expect(modelsChanged(second, third)).toBe(true);
});

test("readModelData round-trips a written file and tolerates a missing one", () => {
  const dir = tmpdir();
  const file = path.join(dir, "model_data.json");
  fs.writeFileSync(file, JSON.stringify({ models: { "a/b": { info: "x" } } }));
  expect(readModelData(file).models["a/b"].info).toBe("x");
  expect(readModelData(path.join(dir, "nope.json"))).toBeNull();
});
