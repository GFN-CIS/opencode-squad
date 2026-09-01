import { expect, test } from "vitest";
import {
  buildRoster,
  diffRoster,
  NOTES_CLOSE,
  NOTES_OPEN,
  parseAgentFile,
  validateRoster,
} from "../src/roster.js";

const FILE = [
  "---",
  "# generated-by: opencode-squad squad-draft",
  "description: cheap long-context coder",
  "mode: subagent",
  "model: zai-coding-plan/glm-5.3",
  "variant: high",
  "steps: 40",
  "hidden: true",
  "---",
  "",
  "ROLE PROMPT with model: not-a-key",
  "",
  NOTES_OPEN,
  "always write files with the write tool",
  NOTES_CLOSE,
].join("\n");

test("parseAgentFile reads the frontmatter and the fenced notes, ignoring the body", () => {
  expect(parseAgentFile(FILE)).toEqual({
    modelId: "zai-coding-plan/glm-5.3",
    entry: {
      description: "cheap long-context coder",
      variant: "high",
      steps: 40,
      notes: "always write files with the write tool",
    },
  });
});

test("parseAgentFile returns an empty entry for a file with no frontmatter", () => {
  expect(parseAgentFile("just a body\nmodel: x/y")).toEqual({ modelId: undefined, entry: {} });
});

test("buildRoster groups by role, keyed and sorted by model id", () => {
  const { roster, conflicts } = buildRoster([
    { role: "grunt", modelId: "z/last", entry: {} },
    { role: "drill", modelId: "a/first", entry: { variant: "max" } },
    { role: "grunt", modelId: "a/first", entry: { variant: "high" } },
  ]);
  expect(conflicts).toEqual([]);
  expect(roster).toEqual({
    grunts: { "a/first": { variant: "high" }, "z/last": {} },
    drills: { "a/first": { variant: "max" } },
  });
});

// The whole point of the tree: one model, two agents, two different levels.
// The previous flat shape could not express this at all.
test("a model can carry a different variant per role", () => {
  const { roster } = buildRoster([
    { role: "grunt", modelId: "a/b", entry: { variant: "high" } },
    { role: "drill", modelId: "a/b", entry: { variant: "max" } },
  ]);
  expect(roster.grunts["a/b"].variant).toBe("high");
  expect(roster.drills["a/b"].variant).toBe("max");
});

test("buildRoster hides a description that is just the role default", () => {
  const { roster } = buildRoster(
    [
      { role: "grunt", modelId: "a/generic", entry: { description: "GENERIC GRUNT" } },
      { role: "grunt", modelId: "a/named", entry: { description: "cheap edits" } },
    ],
    { grunt: "GENERIC GRUNT" },
  );
  expect(roster.grunts["a/generic"]).toEqual({});
  expect(roster.grunts["a/named"]).toEqual({ description: "cheap edits" });
});

test("diffRoster works per AGENT, so removed is exactly the files that would go", () => {
  const current = {
    grunts: { "a/keep": {}, "a/retune": { variant: "low" }, "a/drop": {} },
    drills: { "a/keep": {} },
  };
  const next = {
    grunts: { "a/keep": {}, "a/retune": { variant: "high" }, "a/new": {} },
    drills: {},
  };
  expect(diffRoster(current, next)).toEqual({
    added: ["grunt a/new"],
    removed: ["drill a/keep", "grunt a/drop"],
    changed: ['grunt a/retune: variant "low" -> "high"'],
    unchanged: ["grunt a/keep"],
  });
});

test("diffRoster reports every changed field, not just the first", () => {
  const d = diffRoster(
    { grunts: { "a/b": { variant: "low" } } },
    { grunts: { "a/b": { variant: "high", description: "now useful", steps: 20 } } },
  );
  expect(d.changed[0]).toContain('variant "low" -> "high"');
  expect(d.changed[0]).toContain('description null -> "now useful"');
  expect(d.changed[0]).toContain("steps null -> 20");
});

// "add one model" arriving as a roster containing only that model must read as
// a mass deletion, so the guard stops it rather than obeying it.
test("diffRoster surfaces a carelessly rebuilt roster as a mass deletion", () => {
  const d = diffRoster(
    { grunts: { "a/one": {}, "a/two": {} }, drills: { "a/one": {} } },
    { grunts: { "a/three": {} } },
  );
  expect(d.added).toEqual(["grunt a/three"]);
  expect(d.removed).toEqual(["drill a/one", "grunt a/one", "grunt a/two"]);
});

test("validateRoster accepts a well-formed document, including empty entries", () => {
  expect(
    validateRoster({
      grunts: { "a/b": {}, "c/d": { variant: "high", description: "x", notes: "y", steps: 5 } },
      drills: { "a/b": { disable: true } },
    }),
  ).toEqual([]);
  expect(validateRoster({ grunts: {} })).toEqual([]);
});

test("validateRoster reports every problem at once", () => {
  const errors = validateRoster({
    models: [],
    grunts: { nope: {}, "a/b": { effort: "high", variant: "", steps: 0, disable: "yes" } },
  });
  expect(errors).toEqual(
    expect.arrayContaining([
      expect.stringContaining('unknown top-level key "models"'),
      expect.stringContaining('"nope" is not a provider/model id'),
      expect.stringContaining('unknown key "effort"'),
      expect.stringContaining("variant must be a non-empty string"),
      expect.stringContaining("steps must be a positive integer"),
      expect.stringContaining("disable must be a boolean"),
    ]),
  );
});

test("validateRoster rejects non-objects, and an entry that is not an object", () => {
  expect(validateRoster([])).toEqual(["roster must be a JSON object"]);
  expect(validateRoster({ grunts: [] })).toContain("grunts must be an object keyed by model id");
  expect(validateRoster({ grunts: { "a/b": "high" } })).toContain(
    'grunts["a/b"] must be an object (use {} for no overrides)',
  );
});
