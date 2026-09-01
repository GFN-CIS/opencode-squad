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

test("applySquad writes only the roles an entry asks for", () => {
  const result = apply([{ id: "a/executor", roles: ["grunt"] }, { id: "a/both" }]);
  expect(result.ok).toBe(true);
  expect(fs.readdirSync(dir).sort()).toEqual([
    "drill-a-both.md",
    "grunt-a-both.md",
    "grunt-a-executor.md",
  ]);
  expect(readSquad(dir).roster.models).toEqual([
    { id: "a/both" },
    { id: "a/executor", roles: ["grunt"] },
  ]);
});

// Not every model deserves a reviewer: a drill that cannot review rubber-stamps
// or invents faults. Dropping one must be possible — and must still be gated,
// because it deletes an agent.
test("dropping a role is refused without allowRemove, and writes nothing", () => {
  apply([{ id: "a/weak" }]);
  const before = fs.readdirSync(dir).sort();

  const refused = apply([{ id: "a/weak", roles: ["grunt"], variant: "high" }]);
  expect(refused.ok).toBe(false);
  expect(refused.diff.removed).toEqual([]);
  expect(refused.diff.removedRoles).toEqual([{ id: "a/weak", role: "drill" }]);
  expect(fs.readdirSync(dir).sort()).toEqual(before);
  // The retune that shared the call must not land either — a refusal is total.
  expect(fs.readFileSync(path.join(dir, "grunt-a-weak.md"), "utf8")).not.toContain("variant:");
});

test("dropping a role with allowRemove deletes just that agent", () => {
  apply([{ id: "a/weak" }, { id: "a/keep" }]);
  const result = apply([{ id: "a/weak", roles: ["grunt"] }, { id: "a/keep" }], true);
  expect(result.ok).toBe(true);
  expect(result.pruned).toEqual(["drill-a-weak.md"]);
  expect(fs.readdirSync(dir).sort()).toEqual([
    "drill-a-keep.md",
    "grunt-a-keep.md",
    "grunt-a-weak.md",
  ]);
});

test("adding a missing role to an existing model needs no permission", () => {
  apply([{ id: "a/half", roles: ["grunt"] }]);
  const result = apply([{ id: "a/half" }]);
  expect(result.ok).toBe(true);
  expect(fs.existsSync(path.join(dir, "drill-a-half.md"))).toBe(true);
});

test("formatApplyReport separates models leaving from roles dropped", () => {
  apply([{ id: "a/gone" }, { id: "a/narrow" }]);
  const refused = apply([{ id: "a/narrow", roles: ["grunt"] }]);
  // a/gone is two files, a/narrow loses one — three agents, not "two entries".
  expect(refused.wouldDelete).toBe(3);
  const report = formatApplyReport(refused);
  expect(report).toContain("would DELETE 3 agent file(s)");
  expect(report).toContain("models leaving the squad (1):");
  expect(report).toContain("  - a/gone");
  expect(report).toContain("roles dropped from models that stay (1):");
  expect(report).toContain("  - drill for a/narrow");
});
