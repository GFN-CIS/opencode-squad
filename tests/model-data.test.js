import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  buildModelData,
  discoverSquadModels,
  extractModelId,
  LEGACY_PERF_KEYS,
  mergeModelData,
  modelsChanged,
  readModelData,
} from "../src/model-data.js";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squad-md-"));
  dirs.push(dir);
  return dir;
}

test("extractModelId reads the frontmatter model line only", () => {
  const md = `---\nmode: subagent\nmodel: openai/gpt-5.5\nhidden: true\n---\n\nBody mentions model: anthropic/decoy here.`;
  expect(extractModelId(md)).toBe("openai/gpt-5.5");
});

test("extractModelId returns null when absent", () => {
  expect(extractModelId("---\nmode: subagent\n---\nbody")).toBeNull();
});

test("extractModelId strips the native V2 variant suffix", () => {
  expect(extractModelId("---\nmodel: openai/gpt-5.5#high\n---\n")).toBe("openai/gpt-5.5");
});

test("native drill variants dedupe with grunts and preserve drill-only model data", () => {
  const dir = tmpdir();
  try {
    fs.writeFileSync(path.join(dir, "grunt-shared.md"), "---\nmodel: openai/gpt-5.5\n---\n");
    fs.writeFileSync(path.join(dir, "drill-shared.md"), "---\nmodel: openai/gpt-5.5#high\n---\n");
    fs.writeFileSync(path.join(dir, "drill-only.md"), "---\nmodel: local/reviewer#high\n---\n");
    expect(discoverSquadModels(dir)).toEqual(["local/reviewer", "openai/gpt-5.5"]);
    const snapshot = buildModelData(dir, {
      models: { "local/reviewer": { info: "keep this note" } },
    });
    expect(Object.keys(snapshot.models)).toEqual(["local/reviewer", "openai/gpt-5.5"]);
    expect(snapshot.models["local/reviewer"].info).toBe("keep this note");
    expect(snapshot.models["openai/gpt-5.5"]).toEqual({ info: "" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test("mergeModelData keeps hand fields and strips legacy AA perf fields", () => {
  const existing = {
    models: {
      "zai-coding-plan/glm-5.3": {
        info: "great at coding",
        billing: "subscription",
        cache_ttl_seconds: 300,
        name: "GLM-5.3 (Max)",
        aa_slug: "glm-5-3",
        intelligence: 32,
        coding: null,
        agentic: null,
        price_blended: 2.15,
      },
    },
  };
  const e = mergeModelData(["zai-coding-plan/glm-5.3"], existing)["zai-coding-plan/glm-5.3"];
  expect(e).toEqual({ info: "great at coding", billing: "subscription", cache_ttl_seconds: 300 });
  for (const k of LEGACY_PERF_KEYS) expect(k in e).toBe(false);
});

test("mergeModelData gives new models empty info and drops removed ones", () => {
  const existing = { models: { "old/removed": { info: "gone" } } };
  const merged = mergeModelData(["openai/gpt-5.5"], existing);
  expect(merged["openai/gpt-5.5"].info).toBe("");
  expect("old/removed" in merged).toBe(false); // not in the squad anymore -> dropped
});

test("buildModelData scans a dir and stamps meta", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "grunt-openai-gpt-5-5.md"), "---\nmodel: openai/gpt-5.5\n---\n");
  const snap = buildModelData(dir, {}, "2026-06-30");
  expect(snap._meta.generated).toBe("2026-06-30");
  expect(snap._meta.model_count).toBe(1);
  expect(snap.models["openai/gpt-5.5"]).toEqual({ info: "" });
});

test("modelsChanged detects real model diffs and ignores rebuild churn", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "grunt-openai-gpt-5-5.md"), "---\nmodel: openai/gpt-5.5\n---\n");
  const first = buildModelData(dir, {}, "2026-06-30");
  // rebuild on a later date over the prior output: same models -> no change,
  // so the startup auto-regen must NOT rewrite just because the date moved.
  const second = buildModelData(dir, first, "2026-07-15");
  expect(modelsChanged(first, second)).toBe(false);
  // a hand-edited info IS a change worth persisting
  const edited = { models: { ...first.models } };
  edited.models["openai/gpt-5.5"] = { ...edited.models["openai/gpt-5.5"], info: "new note" };
  expect(modelsChanged(first, edited)).toBe(true);
  // a new squad member is a change
  fs.writeFileSync(path.join(dir, "grunt-anthropic-x.md"), "---\nmodel: anthropic/x\n---\n");
  const third = buildModelData(dir, second, "2026-07-15");
  expect(modelsChanged(second, third)).toBe(true);
});

test("readModelData round-trips a written file and tolerates a missing one", () => {
  const dir = tmpdir();
  const file = path.join(dir, "model_data.json");
  fs.writeFileSync(file, JSON.stringify({ models: { "a/b": { info: "x" } } }));
  expect(readModelData(file).models["a/b"].info).toBe("x");
  expect(readModelData(path.join(dir, "nope.json"))).toBeNull();
});
