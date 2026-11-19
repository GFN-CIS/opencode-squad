// Suite: regressions for unreadable and damaged squad files — #16 (an
// unreadable or damaged apply target), #17 (startup model_data refresh dropping models it
// could not read), #21 (incomplete headers, model ids that are not plain
// YAML), #51 (the generator marker quoted in a hand-authored prompt) and #52
// (a dangling symlink at an apply target). Run: npx vitest run tests/regress-squad-files.test.js

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { parse } from "yaml";
import { ensureGlobalModelDataFresh } from "../.opencode/lib/runtime.js";
import { readFrontmatter } from "../src/frontmatter.js";
import { parseAgentFile } from "../src/roster.js";
import { applySquad, formatApplyReport, readSquad, syncDescriptions } from "../src/squad-apply.js";
import { parseSkillFile } from "../src/v2/skills.js";
import { agentMarkdown } from "../src/workers.js";

const originalXdg = process.env.XDG_CONFIG_HOME;
let root;
let agentDir;
let globalFile;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "squad-regress-"));
  process.env.XDG_CONFIG_HOME = root;
  agentDir = path.join(root, "opencode", "agent");
  globalFile = path.join(root, "opencode", "model_data.json");
  fs.mkdirSync(agentDir, { recursive: true });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  for (const f of fs.readdirSync(agentDir)) fs.chmodSync(path.join(agentDir, f), 0o600);
  fs.rmSync(root, { recursive: true, force: true });
});

/** @param {"grunt"|"drill"} role @param {string} modelId */
function addAgent(role, modelId) {
  const { filename, content } = agentMarkdown(role, modelId, {});
  fs.writeFileSync(path.join(agentDir, filename), content);
  return { filename, content };
}

const isRoot = process.getuid?.() === 0;

// #21

test("a block opened and never closed is incomplete, not absent", () => {
  const cut = '---\n# generated-by: opencode-squad squad-draft\ndescription: "x"\nmod';
  const fm = readFrontmatter(cut);
  expect(fm.state).toBe("incomplete");
  expect(parseAgentFile(cut).modelId).toBeUndefined();
  // A skill keeps reading the whole text as its body, as before.
  expect(parseSkillFile(cut)).toEqual({ fields: {}, body: cut });
  expect(readFrontmatter("---").state).toBe("incomplete");
  expect(readFrontmatter("--- not a delimiter\nmodel: a/b").state).toBe("none");
});

test("a model id that is not a plain YAML scalar is written as a string and round-trips", () => {
  const { content } = agentMarkdown("grunt", "p/m: x", { variant: "high" });
  const header = /^---\n([\s\S]*?)\n---\n/.exec(content)?.[1];
  expect(parse(header ?? "").model).toBe("p/m: x#high");
  expect(readFrontmatter(content).state).toBe("ok");
  expect(parseAgentFile(content)).toMatchObject({ modelId: "p/m: x", entry: { variant: "high" } });
});

test("a plain model id stays unquoted, so existing squads are not rewritten", () => {
  expect(agentMarkdown("grunt", "a/b", { variant: "high" }).content).toContain("model: a/b#high\n");
});

// #17 — each case keeps one healthy agent, so the "no squad, no write" path
// cannot make it pass.

const twoModels = () =>
  JSON.stringify({ models: { "a/b": { info: "rule ab" }, "c/d": { info: "rule cd" } } });

test("a generated agent with a cut-off header keeps its model in model_data", () => {
  addAgent("grunt", "a/b");
  const { filename, content } = addAgent("grunt", "c/d");
  // Truncated in the middle of the header: the marker survives, the model line does not.
  fs.writeFileSync(path.join(agentDir, filename), content.slice(0, content.indexOf("model:") + 4));
  fs.writeFileSync(globalFile, twoModels());
  const before = fs.readFileSync(globalFile, "utf8");
  const r = ensureGlobalModelDataFresh();
  expect(r.wrote).toBe(false);
  expect(r.problem).toContain(`no model in ${filename}`);
  expect(fs.readFileSync(globalFile, "utf8")).toBe(before);
  // squad_dump names the damaged file instead of silently dropping it.
  expect(readSquad(agentDir).conflicts.join("\n")).toContain(filename);
});

test("a legacy worker- file keeps its model in model_data, as squad_dump keeps the agent", () => {
  addAgent("grunt", "a/b");
  const { content } = agentMarkdown("grunt", "c/d", {});
  fs.writeFileSync(path.join(agentDir, "worker-c-d.md"), content);
  fs.writeFileSync(globalFile, twoModels());
  ensureGlobalModelDataFresh();
  const models = JSON.parse(fs.readFileSync(globalFile, "utf8")).models;
  expect(models["c/d"]).toEqual({ info: "rule cd" });
  expect(models["a/b"]).toEqual({ info: "rule ab" });
  expect(readSquad(agentDir).roster.grunts).toHaveProperty("c/d");
});

test("a hand-authored worker- file is not part of the squad", () => {
  addAgent("grunt", "a/b");
  fs.writeFileSync(path.join(agentDir, "worker-mine.md"), "---\nmodel: x/y\n---\nMINE\n");
  fs.writeFileSync(globalFile, JSON.stringify({ models: { "a/b": { info: "" } } }));
  ensureGlobalModelDataFresh();
  expect(Object.keys(JSON.parse(fs.readFileSync(globalFile, "utf8")).models)).toEqual(["a/b"]);
});

test("a hand-authored grunt- file without a readable model does not block the refresh", () => {
  addAgent("grunt", "a/b");
  // Not valid YAML (": " in a plain scalar) and no model line: the file owns no entry.
  fs.writeFileSync(
    path.join(agentDir, "grunt-mine.md"),
    "---\ndescription: Reviews code: fast\n---\nMINE\n",
  );
  fs.writeFileSync(path.join(agentDir, "grunt-rule.md"), "---\nHorizontal rule above, no header\n");
  addAgent("grunt", "c/d");
  fs.writeFileSync(globalFile, JSON.stringify({ models: { "a/b": { info: "rule ab" } } }));
  expect(ensureGlobalModelDataFresh()).toEqual({ wrote: true });
  expect(Object.keys(JSON.parse(fs.readFileSync(globalFile, "utf8")).models)).toEqual([
    "a/b",
    "c/d",
  ]);
});

test("a CRLF header that is never closed is incomplete too", () => {
  expect(readFrontmatter("---\r\nmodel: a/b\r\n").state).toBe("incomplete");
});

// #16

test.skipIf(isRoot)("an unreadable file at a planned destination refuses the whole apply", () => {
  const target = path.join(agentDir, "grunt-a-b.md");
  fs.writeFileSync(target, "---\nmodel: a/b\n---\nMY OWN AGENT\n", { mode: 0o600 });
  fs.chmodSync(target, 0o000);
  const result = applySquad({
    roster: { grunts: { "a/b": {}, "c/d": {} }, drills: {} },
    dir: agentDir,
  });
  expect(result.ok).toBe(false);
  expect(result.ok ? null : result.refusal).toBe("unreadable");
  expect(result.ok ? [] : result.problems).toEqual([`${target}: EACCES (grunt a/b targets it)`]);
  expect(formatApplyReport(result)).toMatch(/REFUSED: an agent file this roster would replace/);
  // Nothing else was written, and the file is as it was.
  expect(fs.readdirSync(agentDir)).toEqual(["grunt-a-b.md"]);
  // Still unreadable at that path: neither replaced nor re-permissioned.
  expect(() => fs.readFileSync(target)).toThrow(/EACCES/);
  fs.chmodSync(target, 0o600);
  expect(fs.readFileSync(target, "utf8")).toBe("---\nmodel: a/b\n---\nMY OWN AGENT\n");
});

test("a damaged generated file at a planned destination refuses the whole apply", () => {
  const { filename, content } = addAgent("grunt", "a/b");
  const target = path.join(agentDir, filename);
  // Cut off mid-header (marker kept, model line lost), then edited by hand.
  const damaged = `${content.slice(0, content.indexOf("model:") + 4)}\n# my local edit\n`;
  fs.writeFileSync(target, damaged);
  // squad_dump reports this very file as damaged and left in place.
  expect(readSquad(agentDir).conflicts.join("\n")).toContain(
    `${filename}: generated file with no readable model`,
  );
  const result = applySquad({
    roster: { grunts: { "a/b": {}, "c/d": {} }, drills: {} },
    dir: agentDir,
  });
  expect(result.ok).toBe(false);
  expect(result.ok ? null : result.refusal).toBe("damaged");
  expect(result.ok ? [] : result.problems).toEqual([
    `${target}: damaged header, no readable model (grunt a/b targets it)`,
  ]);
  const report = formatApplyReport(result);
  expect(report).toMatch(/REFUSED: an agent file this roster would replace has a damaged header/);
  expect(report).not.toMatch(/DELETE|allow_remove/);
  // Nothing else was written, and the damaged file keeps its bytes.
  expect(fs.readdirSync(agentDir)).toEqual([filename]);
  expect(fs.readFileSync(target, "utf8")).toBe(damaged);
});

// #51

// The marker as a markdown heading on its own line in the body: a line-anchored
// check would still claim this file, only the header position must not.
const handAuthoredQuotingMarker = [
  "---",
  'description: "my own grunt"',
  "mode: subagent",
  "model: a/b",
  "---",
  "",
  "Squad files carry this line, do not copy it:",
  "# generated-by: opencode-squad squad-draft",
  "",
].join("\n");

test("a hand-authored agent quoting the generator marker is not ours to sync", () => {
  const target = path.join(agentDir, "grunt-a-b.md");
  fs.writeFileSync(target, handAuthoredQuotingMarker);
  expect(readSquad(agentDir).roster).toEqual({ grunts: {}, drills: {} });
  expect(syncDescriptions({ dir: agentDir, describe: () => "new description" })).toEqual([]);
  expect(fs.readFileSync(target, "utf8")).toBe(handAuthoredQuotingMarker);
});

test("a hand-authored agent quoting the generator marker is a collision for squad_patch", () => {
  const target = path.join(agentDir, "grunt-a-b.md");
  fs.writeFileSync(target, handAuthoredQuotingMarker);
  const result = applySquad({ roster: { grunts: { "a/b": {} }, drills: {} }, dir: agentDir });
  expect(result.ok ? null : result.refusal).toBe("collision");
  expect(result.ok ? [] : result.problems).toEqual([
    "grunt-a-b.md exists and was not generated by this plugin (grunt a/b targets it)",
  ]);
  expect(fs.readFileSync(target, "utf8")).toBe(handAuthoredQuotingMarker);
});

test("a generated file saved with CRLF line endings is still ours", () => {
  const { filename, content } = agentMarkdown("grunt", "a/b", {});
  fs.writeFileSync(path.join(agentDir, filename), content.replaceAll("\n", "\r\n"));
  expect(readSquad(agentDir).roster.grunts).toHaveProperty("a/b");
});

test("another generator's opencode-* marker does not make a file ours", () => {
  const other = [
    "---",
    "# generated-by: opencode-other-tool",
    "model: a/b",
    "---",
    "Their prompt.",
    "",
  ].join("\n");
  const target = path.join(agentDir, "grunt-a-b.md");
  fs.writeFileSync(target, other);
  expect(readSquad(agentDir).roster).toEqual({ grunts: {}, drills: {} });
  expect(syncDescriptions({ dir: agentDir, describe: () => "new description" })).toEqual([]);
  const result = applySquad({ roster: { grunts: { "a/b": {} }, drills: {} }, dir: agentDir });
  expect(result.ok ? null : result.refusal).toBe("collision");
  expect(fs.readFileSync(target, "utf8")).toBe(other);
});

test("a file with the pre-rename opencode-orchestrate marker is still ours", () => {
  const { filename, content } = agentMarkdown("grunt", "a/b", {});
  const legacy = content.replace(
    /generated-by: opencode-squad[^\n]*/,
    "generated-by: opencode-orchestrate generating-model-workers",
  );
  fs.writeFileSync(path.join(agentDir, filename), legacy);
  expect(readSquad(agentDir).roster.grunts).toHaveProperty("a/b");
});

// #52

test("two agent paths linked to one file refuse the apply and change nothing", () => {
  const shared = path.join(root, "dotfiles", "a-b.md");
  fs.mkdirSync(path.dirname(shared), { recursive: true });
  const { content } = agentMarkdown("grunt", "a/b", {});
  fs.writeFileSync(shared, content);
  fs.symlinkSync(shared, path.join(agentDir, "grunt-a-b.md"));
  fs.symlinkSync(shared, path.join(agentDir, "drill-a-b.md"));
  const result = applySquad({
    roster: { grunts: { "a/b": { variant: "low" } }, drills: { "a/b": { variant: "high" } } },
    dir: agentDir,
  });
  expect(result.ok ? null : result.refusal).toBe("collision");
  expect(result.ok ? [] : result.problems).toEqual([
    `drill-a-b.md, grunt-a-b.md all lead to ${fs.realpathSync(shared)}; each agent needs its own file`,
  ]);
  expect(fs.readFileSync(shared, "utf8")).toBe(content);
});

test("a symlink to a file nothing else reaches is still written through", () => {
  const own = path.join(root, "dotfiles", "grunt-a-b.md");
  fs.mkdirSync(path.dirname(own), { recursive: true });
  fs.writeFileSync(own, agentMarkdown("grunt", "a/b", {}).content);
  const link = path.join(agentDir, "grunt-a-b.md");
  fs.symlinkSync(own, link);
  const result = applySquad({
    roster: { grunts: { "a/b": { variant: "low" } }, drills: {} },
    dir: agentDir,
  });
  expect(result.ok).toBe(true);
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(own, "utf8")).toMatch(/low/);
});

test("a dangling symlink at a planned destination refuses the apply and keeps the link", () => {
  const link = path.join(agentDir, "grunt-a-b.md");
  const missing = path.join(root, "dotfiles", "agent", "grunt-a-b.md");
  fs.symlinkSync(missing, link);
  const result = applySquad({
    roster: { grunts: { "a/b": {}, "c/d": {} }, drills: {} },
    dir: agentDir,
  });
  expect(result.ok ? null : result.refusal).toBe("dangling");
  expect(result.ok ? [] : result.problems).toEqual([
    `${link}: symlink to ${missing}, which does not exist (grunt a/b targets it)`,
  ]);
  const report = formatApplyReport(result);
  expect(report).toMatch(/REFUSED: an agent file this roster would replace is a symlink/);
  expect(report).not.toMatch(/DELETE|allow_remove/);
  // Nothing was written, and the link is still the user's link.
  expect(fs.readdirSync(agentDir)).toEqual(["grunt-a-b.md"]);
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(fs.readlinkSync(link)).toBe(missing);
  fs.unlinkSync(link); // afterEach chmods every entry, which a dangling link fails
});
