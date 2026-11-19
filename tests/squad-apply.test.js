// Suite: src/squad-apply.js — the squad_patch decision and report, and the
// read-only import of a squad that earlier versions wrote as agent files.
// Run: npx vitest run tests/squad-apply.test.js

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { formatPatchReport, planPatch, readLegacySquad } from "../src/squad-apply.js";

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "squad-apply-"));
});
afterEach(() => {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.lstatSync(p).isFile()) fs.chmodSync(p, 0o600);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const isRoot = process.getuid?.() === 0;

/** A file as versions before #85 wrote it. */
const legacyFile = (model, extra = "", marker = "opencode-squad squad-draft") =>
  [
    "---",
    `# generated-by: ${marker}`,
    'description: "old"',
    "mode: subagent",
    `model: ${model}`,
    "hidden: true",
    "---",
    "",
    "<!-- squad:prompt role=grunt -->",
    "placeholder",
    "<!-- /squad:prompt -->",
    extra,
  ].join("\n");

const current = { grunts: { "a/one": {}, "a/two": { variant: "high" } }, drills: { "a/one": {} } };

test("planPatch accepts an edit and reports the diff", () => {
  const next = { grunts: { "a/one": {}, "a/two": { variant: "max" } }, drills: { "a/one": {} } };
  const result = planPatch({ current, next });
  expect(result.ok).toBe(true);
  expect(result.diff.changed).toEqual(['grunt a/two: variant "high" -> "max"']);
});

test("planPatch refuses a deletion unless allow_remove", () => {
  const next = { grunts: { "a/one": {} }, drills: {} };
  expect(planPatch({ current, next })).toMatchObject({
    ok: false,
    refusal: "remove",
    problems: ["drill a/one", "grunt a/two"],
  });
  expect(planPatch({ current, next, allowRemove: true }).ok).toBe(true);
});

test("planPatch refuses an id a hand-authored agent holds, even with allow_remove", () => {
  const result = planPatch({
    current,
    next: { ...current, grunts: { ...current.grunts, "b/c": {} } },
    allowRemove: true,
    foreign: [{ id: "grunt-b-c", agent: "grunt b/c" }],
  });
  expect(result).toMatchObject({ ok: false, refusal: "foreign" });
  const report = formatPatchReport(result, { store: "/s.json", roster: current });
  expect(report).toContain("grunt b/c: agent id grunt-b-c is a hand-authored agent");
  expect(report).toMatch(/Nothing was written/);
});

test("the report names every agent a refused apply would delete", () => {
  const result = planPatch({ current, next: { grunts: {}, drills: {} } });
  const report = formatPatchReport(result, { store: "/s.json", roster: {} });
  expect(report).toContain("REFUSED: applying this roster would DELETE 3 agent(s)");
  expect(report).toMatch(/retry with allow_remove/);
});

test("a successful report echoes variants and says no files are written", () => {
  const next = { grunts: { "a/one": {}, "a/two": { variant: "high" } }, drills: { "a/one": {} } };
  const report = formatPatchReport(planPatch({ current, next }), {
    store: "/cfg/squad.json",
    roster: next,
    notes: ["a note"],
  });
  expect(report).toContain("Squad roster: /cfg/squad.json");
  expect(report).toContain("  note   a note");
  expect(report).toContain("=3 unchanged");
  expect(report).toContain("  grunt a/two -> high");
  expect(report).toMatch(/No agent files are written/);
});

test("readLegacySquad imports generated files only, worker- as a grunt", () => {
  fs.writeFileSync(path.join(dir, "grunt-a-one.md"), legacyFile("a/one#high"));
  fs.writeFileSync(
    path.join(dir, "worker-a-two.md"),
    legacyFile("a/two", "", "opencode-orchestrate x"),
  );
  fs.writeFileSync(
    path.join(dir, "drill-a-one.md"),
    legacyFile("a/one").replace("role=grunt", "role=drill"),
  );
  // Hand-authored, another generator's, and the marker only quoted in the body.
  fs.writeFileSync(path.join(dir, "grunt-mine.md"), "---\nmodel: m/n\n---\nmine\n");
  fs.writeFileSync(path.join(dir, "grunt-other.md"), legacyFile("o/p", "", "opencode-other-tool"));
  fs.writeFileSync(
    path.join(dir, "grunt-quoted.md"),
    "---\nmodel: q/r\n---\n# generated-by: opencode-squad squad-draft\n",
  );
  const out = readLegacySquad(dir);
  expect(out.roster).toEqual({
    grunts: { "a/one": { variant: "high" }, "a/two": {} },
    drills: { "a/one": {} },
  });
  expect(out.files).toEqual(["drill-a-one.md", "grunt-a-one.md", "worker-a-two.md"]);
  expect(out.problems).toEqual([]);
});

test("readLegacySquad reads CRLF files and keeps notes", () => {
  fs.writeFileSync(
    path.join(dir, "grunt-a-b.md"),
    legacyFile("a/b", "<!-- squad:notes -->\nshort answers\n<!-- /squad:notes -->").replaceAll(
      "\n",
      "\r\n",
    ),
  );
  expect(readLegacySquad(dir).roster.grunts).toEqual({ "a/b": { notes: "short answers" } });
});

test("a damaged generated file is a problem, never a silently dropped agent", () => {
  fs.writeFileSync(
    path.join(dir, "grunt-a-b.md"),
    "---\n# generated-by: opencode-squad squad-draft\ndescr",
  );
  const out = readLegacySquad(dir);
  expect(out.roster.grunts).toEqual({});
  expect(out.problems).toEqual([
    "grunt-a-b.md: generated file with no readable model (damaged header)",
  ]);
});

test.skipIf(isRoot)("an unreadable squad file is a problem", () => {
  const f = path.join(dir, "grunt-a-b.md");
  fs.writeFileSync(f, legacyFile("a/b"));
  fs.chmodSync(f, 0o000);
  expect(readLegacySquad(dir).problems).toEqual(["grunt-a-b.md: cannot read (EACCES)"]);
});

test("a missing agent dir is an empty legacy squad", () => {
  expect(readLegacySquad(path.join(dir, "nope"))).toEqual({
    roster: { grunts: {}, drills: {} },
    problems: [],
    files: [],
  });
});
