import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { applySquad, formatApplyReport, readSquad, syncDescriptions } from "../src/squad-apply.js";

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
  expect(read("grunt-a-b.md")).toContain("model: a/b#high\n");
  expect(read("drill-a-b.md")).toContain("model: a/b#max\n");
});

test("legacy grunt and drill files read losslessly and regenerate entirely in native format", () => {
  const roster = {
    grunts: { "a/b": { variant: "high", steps: 12, notes: "keep me" } },
    drills: { "a/b": { variant: "max", disable: true } },
  };
  for (const [role, variant] of [
    ["grunt", "high"],
    ["drill", "max"],
  ]) {
    fs.writeFileSync(
      path.join(dir, `${role}-a-b.md`),
      [
        "---",
        "# generated-by: opencode-orchestrate workers-draft",
        "model: a/b",
        `variant: ${variant}`,
        ...(role === "drill" ? ["disable: true"] : ["steps: 12"]),
        "permission:",
        `  edit: ${role === "grunt" ? "allow" : "deny"}`,
        `  bash: ${role === "grunt" ? "allow" : "deny"}`,
        "  task:",
        "    '*': deny",
        "---",
        ...(role === "grunt" ? ["<!-- squad:notes -->", "keep me", "<!-- /squad:notes -->"] : []),
      ].join("\n"),
    );
  }
  expect(readSquad(dir).roster).toEqual(roster);
  expect(apply(readSquad(dir).roster)).toMatchObject({ ok: true, pruned: [] });
  for (const role of ["grunt", "drill"]) {
    const content = read(`${role}-a-b.md`);
    expect(content).toContain(`model: a/b#${role === "grunt" ? "high" : "max"}\n`);
    expect(content).toContain("permissions:\n");
    expect(content).not.toMatch(/\n(?:variant|disable|permission):/);
  }
  expect(read("drill-a-b.md")).toContain("disabled: true\n");
  expect(readSquad(dir).roster).toEqual(roster);
});

test("old generated marker still participates in deletion guards and pruning", () => {
  fs.writeFileSync(
    path.join(dir, "drill-a-old.md"),
    "---\n# generated-by: opencode-orchestrate workers-draft\nmodel: a/old\npermission:\n  bash: deny\n---\n",
  );
  expect(apply({ grunts: {}, drills: {} }).ok).toBe(false);
  expect(apply({ grunts: {}, drills: {} }, true)).toMatchObject({
    ok: true,
    pruned: ["drill-a-old.md"],
  });
  expect(ls()).toEqual([]);
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
  apply({ grunts: { "a/b": {} } });
  fs.renameSync(path.join(dir, "grunt-a-b.md"), path.join(dir, "worker-a-b.md"));
  expect(readSquad(dir).roster.grunts).toEqual({ "a/b": {} });
});

test("applying a roster read from a legacy worker- file leaves the agent in one file", () => {
  apply({ grunts: { "a/b": { variant: "high", notes: "keep" } } });
  fs.renameSync(path.join(dir, "grunt-a-b.md"), path.join(dir, "worker-a-b.md"));
  const result = apply(readSquad(dir).roster);
  expect(result).toMatchObject({ ok: true, pruned: [], migrated: ["worker-a-b.md"] });
  expect(ls()).toEqual(["grunt-a-b.md"]);
  expect(readSquad(dir).roster).toEqual({
    grunts: { "a/b": { variant: "high", notes: "keep" } },
    drills: {},
  });
  // An authorized removal now removes the agent completely.
  expect(apply({ grunts: {}, drills: {} }, true)).toMatchObject({
    ok: true,
    pruned: ["grunt-a-b.md"],
  });
  expect(ls()).toEqual([]);
});

test("removing an agent prunes every file that claims it, legacy name included", () => {
  apply({ grunts: { "a/b": {} } });
  fs.copyFileSync(path.join(dir, "grunt-a-b.md"), path.join(dir, "worker-a-b.md"));
  const result = apply({ grunts: {}, drills: {} }, true);
  expect(result.ok).toBe(true);
  expect(result.pruned.sort()).toEqual(["grunt-a-b.md", "worker-a-b.md"]);
  expect(ls()).toEqual([]);
});

test("two ids that slug to one filename are refused before anything is written", () => {
  apply({ grunts: { "a/keep": {} } });
  const before = ls().map((f) => [f, read(f)]);
  const result = apply({ grunts: { "a/keep": {}, "p/model-1": {}, "p/model.1": {} } }, true);
  expect(result.ok).toBe(false);
  expect(result.refusal).toBe("collision");
  expect(result.problems).toEqual([
    "grunt p/model-1 and grunt p/model.1 would both be written to grunt-p-model-1.md",
  ]);
  expect(ls().map((f) => [f, read(f)])).toEqual(before);
  const report = formatApplyReport(result);
  expect(report).toContain("REFUSED: the roster cannot be written");
  expect(report).toContain("grunt-p-model-1.md");
});

test("replacing an id with one that shares its filename keeps the new agent on disk", () => {
  apply({ grunts: { "p/model.1": { variant: "low" } } });
  const result = apply({ grunts: { "p/model-1": { variant: "high" } } }, true);
  expect(result.ok).toBe(true);
  expect(result.diff.removed).toEqual(["grunt p/model.1"]);
  expect(result.pruned).toEqual([]);
  expect(ls()).toEqual(["grunt-p-model-1.md"]);
  expect(readSquad(dir).roster.grunts).toEqual({ "p/model-1": { variant: "high" } });
});

test("a hand-authored file at the exact destination is never overwritten", () => {
  const mine = "---\nmodel: a/b\ndescription: mine\n---\nMY OWN PROMPT\n";
  fs.writeFileSync(path.join(dir, "grunt-a-b.md"), mine);
  for (const allow of [false, true]) {
    const result = apply({ grunts: { "a/b": {}, "a/c": {} } }, allow);
    expect(result).toMatchObject({ ok: false, refusal: "collision" });
    expect(result.problems).toEqual([
      "grunt-a-b.md exists and was not generated by this plugin (grunt a/b targets it)",
    ]);
  }
  expect(ls()).toEqual(["grunt-a-b.md"]);
  expect(read("grunt-a-b.md")).toBe(mine);
});

test("a byte-identical agent file is not rewritten", () => {
  apply({ grunts: { "a/b": { variant: "high" } } });
  const file = path.join(dir, "grunt-a-b.md");
  const old = new Date("2020-01-01T00:00:00Z");
  fs.utimesSync(file, old, old);
  const result = apply({ grunts: { "a/b": { variant: "high" } } });
  expect(result.written).toEqual([
    { role: "grunt", id: "a/b", variant: "high", filename: "grunt-a-b.md", unchanged: true },
  ]);
  expect(fs.statSync(file).mtimeMs).toBe(old.getTime());
  expect(formatApplyReport(result)).toContain("same   grunt-a-b.md");
});

test("disable is written as frontmatter and survives the round trip", () => {
  apply({ grunts: { "a/b": { disable: true } } });
  expect(read("grunt-a-b.md")).toContain("disabled: true");
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

// Descriptions are plugin-owned: squad_patch and the startup sync both take
// them from describe(), and neither leaks them into the dumped roster.
test("applySquad writes describe()'s description; the dump never carries it", () => {
  applySquad({
    roster: { grunts: { "z/glm": { variant: "high" } } },
    dir,
    describe: (role, id) => `${role} ${id}: Owner rule: no secrets # really`,
  });
  expect(read("grunt-z-glm.md")).toContain(
    'description: "grunt z/glm: Owner rule: no secrets # really"\n',
  );
  expect(readSquad(dir).roster).toEqual({ grunts: { "z/glm": { variant: "high" } }, drills: {} });
});

test("syncDescriptions rewrites only what changed and keeps every roster field", () => {
  apply({
    grunts: { "a/b": { variant: "high", steps: 7, notes: "keep me" }, "c/d": {} },
    drills: { "a/b": { variant: "max" } },
  });
  fs.writeFileSync(path.join(dir, "grunt-hand-made.md"), "---\ndescription: mine\n---\n");
  const before = read("grunt-c-d.md");
  const describe = (role, id) => (id === "a/b" ? `${role}: no secrets` : undefined);

  expect(syncDescriptions({ dir, describe }).sort()).toEqual(["drill-a-b.md", "grunt-a-b.md"]);
  expect(read("grunt-a-b.md")).toContain('description: "grunt: no secrets"\n');
  expect(read("grunt-a-b.md")).toContain("model: a/b#high\nsteps: 7\n");
  expect(read("grunt-a-b.md")).toContain("keep me");
  expect(read("grunt-c-d.md")).toBe(before);
  expect(read("grunt-hand-made.md")).toBe("---\ndescription: mine\n---\n");
  // Idempotent: a second start writes nothing, so opencode reloads nothing.
  expect(syncDescriptions({ dir, describe })).toEqual([]);
  expect(ls().filter((f) => f.endsWith(".tmp"))).toEqual([]);
});

test("syncDescriptions leaves legacy-named files for squad_patch to migrate", () => {
  fs.writeFileSync(
    path.join(dir, "worker-a-b.md"),
    "---\n# generated-by: opencode-squad squad-draft\ndescription: old\nmodel: a/b\n---\n",
  );
  expect(syncDescriptions({ dir, describe: () => "new" })).toEqual([]);
  expect(syncDescriptions({ dir: path.join(dir, "nope"), describe: () => "x" })).toEqual([]);
});

test("formatApplyReport lists descriptions refreshed from model_data.json", () => {
  apply({ grunts: { "a/b": {} } });
  const result = applySquad({
    roster: { grunts: { "a/b": {} } },
    dir,
    describe: () => "grunt. Owner rule: no secrets.",
  });
  expect(result.diff.unchanged).toEqual(["grunt a/b"]);
  const report = formatApplyReport(result);
  expect(report).toContain("Descriptions refreshed from model_data.json (1):");
  expect(report).toContain('~ grunt a/b: "grunt. Owner rule: no secrets."');
  // Same description again: nothing to report.
  expect(
    formatApplyReport(
      applySquad({
        roster: { grunts: { "a/b": {} } },
        dir,
        describe: () => "grunt. Owner rule: no secrets.",
      }),
    ),
  ).not.toContain("refreshed");
});

test("a hand copy of a generated file is a separate agent: removing it needs allow_remove", () => {
  apply({ grunts: { "p/m": {} } });
  fs.copyFileSync(path.join(dir, "grunt-p-m.md"), path.join(dir, "grunt-p-m-copy.md"));
  const refused = apply({ grunts: { "p/m": {} } });
  expect(refused).toMatchObject({ ok: false, refusal: "remove" });
  expect(refused.problems).toEqual(["grunt-p-m-copy.md (a second file for grunt p/m)"]);
  expect(formatApplyReport(refused)).toContain("grunt-p-m-copy.md (a second file for grunt p/m)");
  expect(ls()).toEqual(["grunt-p-m-copy.md", "grunt-p-m.md"]);

  const allowed = apply({ grunts: { "p/m": {} } }, true);
  expect(allowed).toMatchObject({ ok: true, pruned: ["grunt-p-m-copy.md"], migrated: [] });
  expect(ls()).toEqual(["grunt-p-m.md"]);
});

test("a pre-0.4.1 file with an unquoted description is dumped and repaired by the sync", () => {
  fs.writeFileSync(
    path.join(dir, "grunt-a-b.md"),
    [
      "---",
      "# generated-by: opencode-squad squad-draft",
      "description: Per-model grunt. Owner rule: no secrets.",
      "mode: subagent",
      "model: a/b#high",
      "---",
      "",
    ].join("\n"),
  );
  expect(readSquad(dir).roster.grunts).toEqual({ "a/b": { variant: "high" } });
  expect(syncDescriptions({ dir, describe: () => "grunt. Owner rule: no secrets." })).toEqual([
    "grunt-a-b.md",
  ]);
  expect(read("grunt-a-b.md")).toContain('description: "grunt. Owner rule: no secrets."\n');
  expect(readSquad(dir).roster.grunts).toEqual({ "a/b": { variant: "high" } });
});
