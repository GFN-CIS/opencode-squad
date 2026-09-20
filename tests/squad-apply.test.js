import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { applySquad, formatApplyReport, readSquad } from "../src/squad-apply.js";

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "squad-apply-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const apply = (roster, allowRemove = false) => applySquad({ roster, dir, allowRemove });
const ls = () => fs.readdirSync(dir).sort();
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");

test("readSquad treats a missing agent dir as an empty squad, not an error", () => {
  expect(readSquad(path.join(dir, "nope")).roster).toEqual({ grunts: {}, drills: {} });
});

test("applySquad writes one file per agent and reads back losslessly", () => {
  const roster = {
    grunts: {
      "zai-coding-plan/glm-5.3": {
        variant: "high",
        description: "cheap long-context coder",
        notes: "prefer the write tool",
        steps: 40,
      },
      "openai/gpt-5.6-luna": {},
    },
    drills: { "anthropic/claude-opus-5": { variant: "max" } },
  };
  const result = apply(roster);
  expect(result.ok).toBe(true);
  expect(ls()).toEqual([
    "drill-anthropic-claude-opus-5.md",
    "grunt-openai-gpt-5-6-luna.md",
    "grunt-zai-coding-plan-glm-5-3.md",
  ]);
  // The round trip is what makes read-modify-write safe to build on, so every
  // field the roster owns has to survive it — notes included.
  expect(readSquad(dir).roster).toEqual(roster);
});

test("one model can be a grunt at one level and a drill at another", () => {
  apply({
    grunts: { "a/b": { variant: "high" } },
    drills: { "a/b": { variant: "max" } },
  });
  expect(read("grunt-a-b.md")).toContain("variant: high");
  expect(read("drill-a-b.md")).toContain("variant: max");
});

test("a model can be a grunt with no drill at all", () => {
  apply({ grunts: { "a/weak": {} }, drills: {} });
  expect(ls()).toEqual(["grunt-a-weak.md"]);
});

test("applySquad refuses a deletion and writes NOTHING", () => {
  apply({ grunts: { "a/one": {}, "a/two": {} }, drills: { "a/one": {} } });
  const before = ls();

  const result = apply({ grunts: { "a/three": {} }, drills: {} });
  expect(result.ok).toBe(false);
  expect(result.diff.removed).toEqual(["drill a/one", "grunt a/one", "grunt a/two"]);
  expect(result.written).toEqual([]);
  // Total refusal: the agent that WOULD have been added must not appear either.
  expect(ls()).toEqual(before);
});

test("dropping just a drill is a deletion too, and is gated the same way", () => {
  apply({ grunts: { "a/weak": {} }, drills: { "a/weak": {} } });
  const refused = apply({ grunts: { "a/weak": { variant: "high" } }, drills: {} });
  expect(refused.ok).toBe(false);
  expect(refused.diff.removed).toEqual(["drill a/weak"]);
  // The retune that shared the call must not land either.
  expect(read("grunt-a-weak.md")).not.toContain("variant:");

  const allowed = apply({ grunts: { "a/weak": { variant: "high" } }, drills: {} }, true);
  expect(allowed.ok).toBe(true);
  expect(allowed.pruned).toEqual(["drill-a-weak.md"]);
  expect(ls()).toEqual(["grunt-a-weak.md"]);
});

test("adding a drill to an existing grunt needs no permission", () => {
  apply({ grunts: { "a/b": {} } });
  expect(apply({ grunts: { "a/b": {} }, drills: { "a/b": {} } }).ok).toBe(true);
  expect(ls()).toEqual(["drill-a-b.md", "grunt-a-b.md"]);
});

test("a hand-authored agent is invisible: never dumped, never pruned", () => {
  fs.writeFileSync(path.join(dir, "grunt-mine.md"), "---\nmodel: a/mine\n---\nMINE\n");
  expect(readSquad(dir).roster.grunts).toEqual({});
  apply({ grunts: { "a/b": {} } }, true);
  expect(ls()).toContain("grunt-mine.md");
});

test("a legacy worker- file round-trips as a grunt instead of vanishing", () => {
  const legacy = read.bind(null);
  apply({ grunts: { "a/b": {} } });
  fs.renameSync(path.join(dir, "grunt-a-b.md"), path.join(dir, "worker-a-b.md"));
  expect(readSquad(dir).roster.grunts).toEqual({ "a/b": {} });
  expect(typeof legacy).toBe("function");
});

test("disable is written as frontmatter and survives the round trip", () => {
  apply({ grunts: { "a/b": { disable: true } } });
  expect(read("grunt-a-b.md")).toContain("disable: true");
  expect(readSquad(dir).roster.grunts["a/b"]).toEqual({ disable: true });
});

test("formatApplyReport names every agent a refused apply would have deleted", () => {
  apply({ grunts: { "a/one": {} }, drills: { "a/one": {} } });
  const report = formatApplyReport(apply({ grunts: { "a/two": {} } }));
  expect(report).toContain("would DELETE 2 agent(s)");
  expect(report).toContain("- drill a/one");
  expect(report).toContain("- grunt a/one");
  expect(report).toContain("Nothing was written");
});

test("formatApplyReport echoes variants per agent, with the typo warning", () => {
  const report = formatApplyReport(
    apply({ grunts: { "a/b": { variant: "high" } }, drills: { "a/b": { variant: "max" } } }),
  );
  expect(report).toContain("IGNORES an unrecognized variant");
  expect(report).toContain("grunt a/b -> high");
  expect(report).toContain("drill a/b -> max");
});

test("formatApplyReport omits the variant block when nothing set one", () => {
  expect(formatApplyReport(apply({ grunts: { "a/b": {} } }))).not.toContain("Variants written");
});
