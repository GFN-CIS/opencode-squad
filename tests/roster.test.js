import { expect, test } from "vitest";
import {
  buildRoster,
  diffRoster,
  parseAgentFrontmatter,
  ROSTER_VERSION,
  rolesOf,
  validateRoster,
} from "../src/roster.js";

const AGENT = [
  "---",
  "# generated-by: opencode-squad squad-draft",
  "description: Per-model grunt (worker) for the sarge PDCA cycle.",
  "mode: subagent",
  "model: zai-coding-plan/glm-5.3",
  "variant: high",
  "hidden: true",
  "permission:",
  "  edit: allow",
  "---",
  "",
  "BODY with model: not-a-real-key",
].join("\n");

test("parseAgentFrontmatter reads model and variant, and stops at the closing fence", () => {
  expect(parseAgentFrontmatter(AGENT)).toEqual({
    modelId: "zai-coding-plan/glm-5.3",
    variant: "high",
  });
});

test("parseAgentFrontmatter returns nothing for a file with no frontmatter", () => {
  expect(parseAgentFrontmatter("just a body\nmodel: x/y")).toEqual({});
});

test("buildRoster folds the grunt+drill pair of a model into one sorted entry", () => {
  const { roster, conflicts } = buildRoster([
    { modelId: "zai-coding-plan/glm-5.3", variant: "high" },
    { modelId: "zai-coding-plan/glm-5.3", variant: "high" },
    { modelId: "anthropic/claude-opus-5" },
    { modelId: "anthropic/claude-opus-5" },
  ]);
  expect(conflicts).toEqual([]);
  expect(roster).toEqual({
    version: ROSTER_VERSION,
    models: [{ id: "anthropic/claude-opus-5" }, { id: "zai-coding-plan/glm-5.3", variant: "high" }],
  });
});

test("buildRoster reports a model whose two agents disagree instead of silently picking", () => {
  const { roster, conflicts } = buildRoster([
    { modelId: "a/b", variant: "high" },
    { modelId: "a/b", variant: "low" },
  ]);
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]).toContain("a/b");
  expect(conflicts[0]).toContain("high");
  expect(conflicts[0]).toContain("low");
  expect(roster.models).toEqual([{ id: "a/b", variant: "high" }]);
});

test("diffRoster separates added, removed, changed and unchanged", () => {
  const current = {
    models: [
      { id: "a/keep" },
      { id: "a/retune", variant: "medium" },
      { id: "a/drop", variant: "high" },
    ],
  };
  const next = {
    models: [
      { id: "a/keep" },
      { id: "a/retune", variant: "high" },
      { id: "a/new", variant: "low" },
    ],
  };
  expect(diffRoster(current, next)).toEqual({
    added: ["a/new@low"],
    removed: ["a/drop"],
    changed: ["a/retune: medium -> high"],
    unchanged: ["a/keep"],
    removedRoles: [],
  });
});

test("diffRoster treats adding a variant to an existing model as a change, not a removal", () => {
  const d = diffRoster({ models: [{ id: "a/b" }] }, { models: [{ id: "a/b", variant: "high" }] });
  expect(d.removed).toEqual([]);
  expect(d.added).toEqual([]);
  expect(d.changed).toEqual(["a/b: no variant -> high"]);
});

// The bug this whole flow exists to stop: "add one model" arriving as a roster
// containing only that model. The diff must see it as three removals so the
// caller is stopped, not obeyed.
test("diffRoster surfaces the careless single-model roster as a mass removal", () => {
  const current = { models: [{ id: "a/one" }, { id: "a/two" }, { id: "a/three" }] };
  const next = { models: [{ id: "a/four" }] };
  const d = diffRoster(current, next);
  expect(d.added).toEqual(["a/four"]);
  expect(d.removed).toEqual(["a/one", "a/three", "a/two"]);
});

test("validateRoster accepts a well-formed document", () => {
  expect(
    validateRoster({
      version: ROSTER_VERSION,
      models: [{ id: "a/b" }, { id: "c/d", variant: "high" }],
    }),
  ).toEqual([]);
});

test("validateRoster reports every problem at once", () => {
  const errors = validateRoster({
    version: 99,
    extra: true,
    models: [{ id: "nope" }, { id: "a/b", effort: "high" }, { id: "a/b" }, "x"],
  });
  expect(errors).toEqual(
    expect.arrayContaining([
      expect.stringContaining("version must be 1"),
      expect.stringContaining('unknown top-level key "extra"'),
      expect.stringContaining("is not a provider/model id"),
      expect.stringContaining('unknown key "effort"'),
      expect.stringContaining("is listed twice"),
      expect.stringContaining("models[3] must be an object"),
    ]),
  );
});

test("validateRoster rejects non-objects and a non-array models field", () => {
  expect(validateRoster([])).toEqual(["roster must be a JSON object"]);
  expect(validateRoster(null)).toEqual(["roster must be a JSON object"]);
  expect(validateRoster({ version: ROSTER_VERSION, models: {} })).toContain(
    "models must be an array",
  );
});

test("validateRoster rejects an empty-string variant rather than writing a blank key", () => {
  expect(
    validateRoster({ version: ROSTER_VERSION, models: [{ id: "a/b", variant: "  " }] }),
  ).toEqual(["models[0].variant must be a non-empty string when present"]);
});

test("buildRoster reports a grunt-only model as roles:[grunt], and a full pair as default", () => {
  const { roster } = buildRoster([
    { modelId: "a/full", role: "grunt" },
    { modelId: "a/full", role: "drill" },
    { modelId: "a/executor", role: "grunt", variant: "high" },
  ]);
  expect(roster.models).toEqual([
    { id: "a/executor", variant: "high", roles: ["grunt"] },
    { id: "a/full" },
  ]);
});

test("buildRoster maps a legacy worker- file onto the grunt role", () => {
  const { roster } = buildRoster([{ modelId: "a/old", role: "grunt" }]);
  expect(roster.models).toEqual([{ id: "a/old", roles: ["grunt"] }]);
});

test("rolesOf defaults to both, because omitting the field must never delete", () => {
  expect(rolesOf(undefined)).toEqual(["grunt", "drill"]);
  expect(rolesOf([])).toEqual(["grunt", "drill"]);
  expect(rolesOf(["drill"])).toEqual(["drill"]);
  // Order is normalized, so ["drill","grunt"] and ["grunt","drill"] are one shape.
  expect(rolesOf(["drill", "grunt"])).toEqual(["grunt", "drill"]);
});

test("diffRoster reports a narrowed role set as a change AND as a role removal", () => {
  const d = diffRoster({ models: [{ id: "a/b" }] }, { models: [{ id: "a/b", roles: ["grunt"] }] });
  expect(d.removed).toEqual([]);
  expect(d.changed).toEqual(["a/b: roles grunt+drill -> grunt (drops drill)"]);
  expect(d.removedRoles).toEqual([{ id: "a/b", role: "drill" }]);
});

test("diffRoster treats gaining a role as a change with nothing removed", () => {
  const d = diffRoster({ models: [{ id: "a/b", roles: ["grunt"] }] }, { models: [{ id: "a/b" }] });
  expect(d.removedRoles).toEqual([]);
  expect(d.changed).toEqual(["a/b: roles grunt -> grunt+drill"]);
});

test("diffRoster labels an added grunt-only model so the report shows the shape", () => {
  const d = diffRoster(
    { models: [] },
    { models: [{ id: "a/b", variant: "high", roles: ["grunt"] }] },
  );
  expect(d.added).toEqual(["a/b@high (grunt only)"]);
});

test("validateRoster rejects an unknown or empty roles list", () => {
  expect(
    validateRoster({ version: ROSTER_VERSION, models: [{ id: "a/b", roles: ["sarge"] }] }),
  ).toEqual(['models[0].roles has unknown role "sarge"']);
  expect(validateRoster({ version: ROSTER_VERSION, models: [{ id: "a/b", roles: [] }] })).toEqual([
    "models[0].roles must be a non-empty array when present",
  ]);
  expect(
    validateRoster({ version: ROSTER_VERSION, models: [{ id: "a/b", roles: ["drill"] }] }),
  ).toEqual([]);
});
