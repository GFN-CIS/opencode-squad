// Suite: .opencode/lib/runtime.js — the model_data.json read layer, the
// startup regen from squad.json, and the one-time import of a squad that
// earlier versions wrote as agent files. XDG_CONFIG_HOME points at a temp
// dir, so the real global config is never read or written.
// Run: npx vitest run tests/runtime-model-data.test.js

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  ensureGlobalModelDataFresh,
  importLegacySquad,
  loadModelSettings,
} from "../.opencode/lib/runtime.js";
import { readStore, writeStore } from "../src/squad-store.js";

const originalXdg = process.env.XDG_CONFIG_HOME;
let root;
let configDir;
let globalFile;
let storeFile;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "squad-runtime-"));
  process.env.XDG_CONFIG_HOME = root;
  configDir = path.join(root, "opencode");
  globalFile = path.join(configDir, "model_data.json");
  storeFile = path.join(configDir, "squad.json");
  fs.mkdirSync(path.join(configDir, "agent"), { recursive: true });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  fs.rmSync(root, { recursive: true, force: true });
});

/** @param {string[]} ids */
const squadOf = (...ids) =>
  writeStore(storeFile, { grunts: Object.fromEntries(ids.map((id) => [id, {}])), drills: {} });

/** A squad file as versions before #85 wrote it. */
const legacyFile = (model, description = '"old"') =>
  [
    "---",
    "# generated-by: opencode-squad squad-draft",
    `description: ${description}`,
    "mode: subagent",
    `model: ${model}`,
    "---",
    "",
  ].join("\n");

test("an invalid global model_data.json is left byte-for-byte intact at startup", () => {
  squadOf("a/b");
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
  expect(fs.readdirSync(configDir).sort()).toEqual(["agent", "model_data.json", "squad.json"]);
});

test("a missing file is generated from squad.json; a valid one keeps hand-edited fields", () => {
  squadOf("a/b");
  expect(ensureGlobalModelDataFresh()).toEqual({ wrote: true });
  const first = JSON.parse(fs.readFileSync(globalFile, "utf8"));
  expect(Object.keys(first.models)).toEqual(["a/b"]);

  first.models["a/b"].info = "no secrets";
  first.providers = { a: "Max 5x" };
  fs.writeFileSync(globalFile, JSON.stringify(first));
  squadOf("a/b", "c/d");
  expect(ensureGlobalModelDataFresh()).toEqual({ wrote: true });
  const second = JSON.parse(fs.readFileSync(globalFile, "utf8"));
  expect(second.models["a/b"].info).toBe("no secrets");
  expect(second.models["c/d"]).toEqual({ info: "" });
  expect(second.providers).toEqual({ a: "Max 5x" });
  expect(ensureGlobalModelDataFresh()).toEqual({ wrote: false }); // unchanged -> no write
});

test("an unreadable squad.json keeps model_data untouched; none at all is no squad", () => {
  fs.writeFileSync(globalFile, JSON.stringify({ models: { "a/b": { info: "keep me" } } }));
  const before = fs.readFileSync(globalFile, "utf8");
  expect(ensureGlobalModelDataFresh()).toEqual({ wrote: false });
  fs.writeFileSync(storeFile, "{broken");
  const r = ensureGlobalModelDataFresh();
  expect(r.wrote).toBe(false);
  expect(r.problem).toContain(storeFile);
  expect(fs.readFileSync(globalFile, "utf8")).toBe(before);
});

test("the legacy squad is imported once, files left in place, owner notes kept", () => {
  const agentDir = path.join(configDir, "agent");
  // A pre-0.4.1 header: description unquoted, not valid YAML.
  fs.writeFileSync(
    path.join(agentDir, "grunt-a-b.md"),
    legacyFile("a/b#high", "Per-model grunt. Owner rule: no secrets."),
  );
  fs.writeFileSync(path.join(agentDir, "drill-c-d.md"), legacyFile("c/d"));
  const files = fs.readdirSync(agentDir).sort();
  fs.writeFileSync(globalFile, JSON.stringify({ models: { "a/b": { info: "keep me" } } }));

  expect(importLegacySquad()).toEqual({ imported: 2, problems: [] });
  expect(readStore(storeFile)).toMatchObject({
    state: "ok",
    roster: { grunts: { "a/b": { variant: "high" } }, drills: { "c/d": {} } },
  });
  expect(fs.readdirSync(agentDir).sort()).toEqual(files);
  ensureGlobalModelDataFresh();
  expect(JSON.parse(fs.readFileSync(globalFile, "utf8")).models["a/b"].info).toBe("keep me");

  // Once squad.json exists it is the squad: no second import.
  fs.writeFileSync(path.join(agentDir, "grunt-e-f.md"), legacyFile("e/f"));
  expect(importLegacySquad()).toEqual({ imported: 0, problems: [] });
  expect(readStore(storeFile).roster?.grunts).not.toHaveProperty("e/f");
});

test("a damaged legacy file blocks the import rather than dropping that agent", () => {
  const agentDir = path.join(configDir, "agent");
  fs.writeFileSync(path.join(agentDir, "grunt-a-b.md"), legacyFile("a/b"));
  fs.writeFileSync(
    path.join(agentDir, "grunt-c-d.md"),
    "---\n# generated-by: opencode-squad x\ndesc",
  );
  const r = importLegacySquad();
  expect(r.imported).toBe(0);
  expect(r.problems).toEqual([expect.stringContaining("grunt-c-d.md")]);
  expect(fs.existsSync(storeFile)).toBe(false);
});

test("legacy files whose models map to one agent id block the import (#90)", () => {
  const agentDir = path.join(configDir, "agent");
  fs.writeFileSync(path.join(agentDir, "grunt-p-m-1.md"), legacyFile("p/m-1"));
  fs.writeFileSync(path.join(agentDir, "grunt-p-m-1-copy.md"), legacyFile("p/m.1"));
  const r = importLegacySquad();
  expect(r.imported).toBe(0);
  expect(r.problems).toEqual([expect.stringContaining("grunt-p-m-1")]);
  expect(fs.existsSync(storeFile)).toBe(false);
});

test("no legacy squad, no import: squad.json is not created empty", () => {
  expect(importLegacySquad()).toEqual({ imported: 0, problems: [] });
  expect(fs.existsSync(storeFile)).toBe(false);
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
