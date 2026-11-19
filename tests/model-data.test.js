import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  buildModelData,
  LEGACY_PERF_KEYS,
  mergeModelData,
  modelsChanged,
  readModelDataFile,
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

test("drill and grunt of one model share one entry; drill-only notes survive", () => {
  const snapshot = buildModelData(["local/reviewer", "openai/gpt-5.5"], {
    models: { "local/reviewer": { info: "keep this note" } },
  });
  expect(Object.keys(snapshot.models)).toEqual(["local/reviewer", "openai/gpt-5.5"]);
  expect(snapshot.models["local/reviewer"].info).toBe("keep this note");
  expect(snapshot.models["openai/gpt-5.5"]).toEqual({ info: "" });
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

test("buildModelData stamps meta", () => {
  const snap = buildModelData(["openai/gpt-5.5"], {}, "2026-06-30");
  expect(snap._meta.generated).toBe("2026-06-30");
  expect(snap._meta.model_count).toBe(1);
  expect(snap.models["openai/gpt-5.5"]).toEqual({ info: "" });
});

test("modelsChanged detects real model diffs and ignores rebuild churn", () => {
  const first = buildModelData(["openai/gpt-5.5"], {}, "2026-06-30");
  // rebuild on a later date over the prior output: same models -> no change,
  // so the startup auto-regen must NOT rewrite just because the date moved.
  const second = buildModelData(["openai/gpt-5.5"], first, "2026-07-15");
  expect(modelsChanged(first, second)).toBe(false);
  // a hand-edited info IS a change worth persisting
  const edited = { models: { ...first.models } };
  edited.models["openai/gpt-5.5"] = { ...edited.models["openai/gpt-5.5"], info: "new note" };
  expect(modelsChanged(first, edited)).toBe(true);
  // a new squad member is a change
  const third = buildModelData(["anthropic/x", "openai/gpt-5.5"], second, "2026-07-15");
  expect(modelsChanged(second, third)).toBe(true);
});

test("readModelDataFile round-trips a written file and reports a missing one as missing", () => {
  const dir = tmpdir();
  const file = path.join(dir, "model_data.json");
  fs.writeFileSync(file, JSON.stringify({ models: { "a/b": { info: "x" } } }));
  const read = readModelDataFile(file);
  expect(read.state).toBe("ok");
  expect(read.data.models["a/b"].info).toBe("x");
  expect(readModelDataFile(path.join(dir, "nope.json"))).toEqual({ state: "missing" });
});

test("readModelDataFile tells an invalid file apart from a missing one, without quoting it", () => {
  const dir = tmpdir();
  const file = path.join(dir, "model_data.json");
  fs.writeFileSync(file, '{"models": {"a/b": {"info": "SECRET-RULE"}},}');
  const bad = readModelDataFile(file);
  expect(bad.state).toBe("invalid");
  expect(bad.reason).toMatch(/^invalid JSON/);
  expect(bad.reason).not.toContain("SECRET");
  fs.writeFileSync(file, "[1, 2]");
  expect(readModelDataFile(file)).toEqual({ state: "invalid", reason: "not a JSON object" });
  fs.writeFileSync(file, '{"models": []}');
  expect(readModelDataFile(file)).toEqual({
    state: "invalid",
    reason: '"models" is not an object',
  });
  // A valid object with neither section is still the owner's file.
  fs.writeFileSync(file, '{"note": "mine"}');
  expect(readModelDataFile(file)).toEqual({ state: "ok", data: { models: {}, note: "mine" } });
  // A directory where the file should be is unreadable, not missing.
  const asDir = path.join(dir, "dir.json");
  fs.mkdirSync(asDir);
  expect(readModelDataFile(asDir)).toEqual({ state: "invalid", reason: "unreadable (EISDIR)" });
});

test("buildModelData keeps the hand-written providers section", () => {
  const snap = buildModelData(
    ["anthropic/x"],
    { providers: { anthropic: "Max 5x" }, models: {} },
    "2026-11-12",
  );
  expect(snap.providers).toEqual({ anthropic: "Max 5x" });
  expect(modelsChanged({ models: {} }, snap)).toBe(true);
});

test("readModelDataFile accepts a file with only providers", () => {
  const dir = tmpdir();
  const file = path.join(dir, "model_data.json");
  fs.writeFileSync(file, JSON.stringify({ providers: { openai: "api" } }));
  expect(readModelDataFile(file)).toEqual({
    state: "ok",
    data: { models: {}, providers: { openai: "api" } },
  });
});
