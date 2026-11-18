// Suite: .opencode/lib/runtime.js — the model_data.json read layer and the
// startup regen. XDG_CONFIG_HOME points at a temp dir, so the real global
// config is never read or written.
// Run: npx vitest run tests/runtime-model-data.test.js

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  ensureGlobalModelDataFresh,
  loadModelSettings,
  syncGlobalSquadDescriptions,
} from "../.opencode/lib/runtime.js";
import { agentMarkdown } from "../src/workers.js";

const originalXdg = process.env.XDG_CONFIG_HOME;
let root;
let configDir;
let globalFile;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "squad-runtime-"));
  process.env.XDG_CONFIG_HOME = root;
  configDir = path.join(root, "opencode");
  globalFile = path.join(configDir, "model_data.json");
  fs.mkdirSync(path.join(configDir, "agent"), { recursive: true });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  fs.rmSync(root, { recursive: true, force: true });
});

/** @param {string} modelId */
function addGrunt(modelId) {
  const { filename, content } = agentMarkdown("grunt", modelId, {});
  fs.writeFileSync(path.join(configDir, "agent", filename), content);
}

test("an invalid global model_data.json is left byte-for-byte intact at startup", () => {
  addGrunt("a/b");
  const broken = '{"models": {"a/b": {"info": "SECRET owner rule"}}, "providers": {"a": "Max"},}';
  fs.writeFileSync(globalFile, broken);
  const r = ensureGlobalModelDataFresh();
  expect(r.wrote).toBe(false);
  expect(r.problem).toContain(globalFile);
  expect(r.problem).toMatch(/invalid JSON/);
  expect(r.problem).not.toContain("SECRET");
  expect(fs.readFileSync(globalFile, "utf8")).toBe(broken);
  expect(String(console.warn.mock.calls[0][0])).not.toContain("SECRET");
  // No temp file left behind either.
  expect(fs.readdirSync(configDir).sort()).toEqual(["agent", "model_data.json"]);
});

test("a missing file is generated; a valid one keeps hand-edited fields on refresh", () => {
  addGrunt("a/b");
  expect(ensureGlobalModelDataFresh()).toEqual({ wrote: true });
  const first = JSON.parse(fs.readFileSync(globalFile, "utf8"));
  expect(Object.keys(first.models)).toEqual(["a/b"]);

  first.models["a/b"].info = "no secrets";
  first.providers = { a: "Max 5x" };
  fs.writeFileSync(globalFile, JSON.stringify(first));
  addGrunt("c/d");
  expect(ensureGlobalModelDataFresh()).toEqual({ wrote: true });
  const second = JSON.parse(fs.readFileSync(globalFile, "utf8"));
  expect(second.models["a/b"].info).toBe("no secrets");
  expect(second.models["c/d"]).toEqual({ info: "" });
  expect(second.providers).toEqual({ a: "Max 5x" });
  expect(ensureGlobalModelDataFresh()).toEqual({ wrote: false }); // unchanged -> no write
});

test("a squad file that cannot be read keeps model_data untouched", () => {
  addGrunt("a/b");
  fs.writeFileSync(globalFile, JSON.stringify({ models: { "a/b": { info: "keep me" } } }));
  const before = fs.readFileSync(globalFile, "utf8");
  // Unreadable as a file (a directory under that name): its model is unknown.
  fs.mkdirSync(path.join(configDir, "agent", "grunt-c-d.md"));
  const r = ensureGlobalModelDataFresh();
  expect(r.wrote).toBe(false);
  expect(r.problem).toContain("grunt-c-d.md");
  expect(fs.readFileSync(globalFile, "utf8")).toBe(before);
});

test("a pre-0.4.1 agent with an unquoted description keeps its model entry", () => {
  const legacy = [
    "---",
    "# generated-by: opencode-squad squad-draft",
    "description: Per-model grunt. Owner rule: no secrets.",
    "mode: subagent",
    "model: a/b#high",
    "---",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(configDir, "agent", "grunt-a-b.md"), legacy);
  fs.writeFileSync(globalFile, JSON.stringify({ models: { "a/b": { info: "keep me" } } }));
  ensureGlobalModelDataFresh();
  expect(JSON.parse(fs.readFileSync(globalFile, "utf8")).models["a/b"].info).toBe("keep me");
});

test("description sync is skipped while the global file is unreadable", () => {
  addGrunt("a/b");
  fs.writeFileSync(globalFile, "{not json");
  const file = path.join(configDir, "agent", "grunt-a-b.md");
  const before = fs.readFileSync(file, "utf8");
  expect(syncGlobalSquadDescriptions()).toEqual([]);
  expect(fs.readFileSync(file, "utf8")).toBe(before);
});

test("models and providers come from one read: project over global by key, global-only for null", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "squad-project-"));
  try {
    fs.writeFileSync(
      globalFile,
      JSON.stringify({
        models: { "a/b": { info: "global ab" }, "c/d": { info: "global cd" } },
        providers: { a: "Max 5x", c: "api" },
      }),
    );
    fs.mkdirSync(path.join(project, ".opencode"));
    const projectFile = path.join(project, ".opencode", "model_data.json");
    fs.writeFileSync(
      projectFile,
      JSON.stringify({ models: { "a/b": { info: "project ab" } }, providers: { c: "Pro" } }),
    );

    const merged = loadModelSettings(project);
    expect(merged.models["a/b"].info).toBe("project ab");
    expect(merged.models["c/d"].info).toBe("global cd");
    expect(merged.providers).toEqual({ a: "Max 5x", c: "Pro" });
    expect(merged.problems).toEqual([]);

    const globalOnly = loadModelSettings(null);
    expect(globalOnly.models["a/b"].info).toBe("global ab");
    expect(globalOnly.providers).toEqual({ a: "Max 5x", c: "api" });

    // An edit is visible on the next call, both sections at once.
    fs.writeFileSync(
      projectFile,
      JSON.stringify({ models: { "a/b": { info: "edited ab!" } }, providers: { c: "Pro+" } }),
    );
    const edited = loadModelSettings(project);
    expect(edited.models["a/b"].info).toBe("edited ab!");
    expect(edited.providers.c).toBe("Pro+");

    // A broken project file is reported and ignored; the global one still applies.
    fs.writeFileSync(projectFile, "{oops");
    const broken = loadModelSettings(project);
    expect(broken.models["a/b"].info).toBe("global ab");
    expect(broken.problems).toEqual([expect.stringContaining(projectFile)]);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
