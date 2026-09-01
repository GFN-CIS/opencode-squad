import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ROSTER_VERSION } from "../src/roster.js";
import { applySquad, formatApplyReport, readSquad } from "../src/squad-apply.js";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "squad-apply-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const apply = (models, allowRemove = false) =>
  applySquad({
    roster: { version: ROSTER_VERSION, models },
    dir,
    allowRemove,
    packageRoot: PACKAGE_ROOT,
  });

test("readSquad treats a missing agent dir as an empty squad, not an error", () => {
  const { roster } = readSquad(path.join(dir, "does-not-exist"));
  expect(roster).toEqual({ version: ROSTER_VERSION, models: [] });
});

test("applySquad writes a grunt and a drill per model, and reads back identically", () => {
  const result = apply([{ id: "zai-coding-plan/glm-5.3", variant: "high" }, { id: "a/plain" }]);
  expect(result.ok).toBe(true);
  expect(result.written).toHaveLength(4);
  expect(fs.readdirSync(dir).sort()).toEqual([
    "drill-a-plain.md",
    "drill-zai-coding-plan-glm-5-3.md",
    "grunt-a-plain.md",
    "grunt-zai-coding-plan-glm-5-3.md",
  ]);
  // The roster is derived from the files, so a round trip must be lossless —
  // that is what makes read-modify-write safe to build on.
  expect(readSquad(dir).roster).toEqual({
    version: ROSTER_VERSION,
    models: [{ id: "a/plain" }, { id: "zai-coding-plan/glm-5.3", variant: "high" }],
  });
});

test("applySquad refuses a removal and writes NOTHING when allowRemove is off", () => {
  apply([{ id: "a/one" }, { id: "a/two" }]);
  const before = fs.readdirSync(dir).sort();

  const result = apply([{ id: "a/three" }]);
  expect(result.ok).toBe(false);
  expect(result.diff.removed).toEqual(["a/one", "a/two"]);
  expect(result.written).toEqual([]);
  expect(result.pruned).toEqual([]);
  // The refusal must be total: no partial write of the model that WOULD be added.
  expect(fs.readdirSync(dir).sort()).toEqual(before);
});

test("applySquad removes only when told to, and only its own files", () => {
  apply([{ id: "a/one" }, { id: "a/two" }]);
  fs.writeFileSync(path.join(dir, "grunt-hand-written.md"), "---\nmodel: a/mine\n---\nMINE\n");

  const result = apply([{ id: "a/one" }], true);
  expect(result.ok).toBe(true);
  expect(result.diff.removed).toEqual(["a/two"]);
  expect(fs.readdirSync(dir).sort()).toEqual([
    "drill-a-one.md",
    "grunt-a-one.md",
    "grunt-hand-written.md",
  ]);
});

test("a hand-authored agent is invisible to readSquad even when it looks like ours", () => {
  fs.writeFileSync(path.join(dir, "grunt-hand-written.md"), "---\nmodel: a/mine\n---\nMINE\n");
  expect(readSquad(dir).roster.models).toEqual([]);
});

test("retuning a variant rewrites in place and is reported as a change, not a removal", () => {
  apply([{ id: "a/one", variant: "low" }]);
  const result = apply([{ id: "a/one", variant: "high" }]);
  expect(result.ok).toBe(true);
  expect(result.diff).toMatchObject({ removed: [], added: [], changed: ["a/one: low -> high"] });
  expect(fs.readFileSync(path.join(dir, "grunt-a-one.md"), "utf8")).toContain("variant: high");
});

test("formatApplyReport names every model a refused apply would have removed", () => {
  apply([{ id: "a/one" }, { id: "a/two" }]);
  const report = formatApplyReport(apply([{ id: "a/three" }]));
  expect(report).toContain("REFUSED");
  expect(report).toContain("- a/one");
  expect(report).toContain("- a/two");
  expect(report).toContain("Nothing was written");
  expect(report).toContain("allow_remove");
});

test("formatApplyReport echoes written variants once per model, with the typo warning", () => {
  const report = formatApplyReport(apply([{ id: "a/one", variant: "high" }, { id: "a/two" }]));
  expect(report).toContain("Variants written");
  expect(report).toContain("IGNORES an unrecognized variant");
  expect(report.match(/a\/one -> high/g)).toHaveLength(1); // not once per role file
  expect(report).not.toContain("a/two ->");
});

test("formatApplyReport omits the variant block entirely when no variant was set", () => {
  expect(formatApplyReport(apply([{ id: "a/one" }]))).not.toContain("Variants written");
});
