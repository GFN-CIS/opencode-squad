// Suite: src/squad-agents.js — the agents a roster registers, and the early
// and late agent transforms, against a fake host editor. The real host order
// is covered by tests-integration/squad-agents.test.js.
// Run: npx vitest run tests/squad-agents.test.js

import { expect, test } from "vitest";
import { PROMPT_CLOSE, promptOpen } from "../src/prompt-inject.js";
import { NOTES_CLOSE, NOTES_OPEN } from "../src/roster.js";
import { agentSpecs, earlyTransform, isSquadSystem, lateTransform } from "../src/squad-agents.js";
import { roleRules } from "../src/workers.js";

const io = {
  describe: (role, id) => `${role} on ${id}`,
  prompt: (role) => `the ${role} prompt`,
};

test("one agent per role entry, with model, variant, steps and description", () => {
  const specs = agentSpecs(
    {
      grunts: { "zai-coding-plan/glm-5.3": { variant: "high", steps: 40 } },
      drills: { "openrouter/anthropic/claude-x": {} },
    },
    io,
  );
  expect(specs.map((s) => s.id)).toEqual([
    "grunt-zai-coding-plan-glm-5-3",
    "drill-openrouter-anthropic-claude-x",
  ]);
  expect(specs[0]).toMatchObject({
    role: "grunt",
    modelId: "zai-coding-plan/glm-5.3",
    description: "grunt on zai-coding-plan/glm-5.3",
    model: { providerID: "zai-coding-plan", id: "glm-5.3", variant: "high" },
    steps: 40,
    permissions: roleRules("grunt"),
  });
  // Only the first slash separates the provider.
  expect(specs[1].model).toEqual({ providerID: "openrouter", id: "anthropic/claude-x" });
  expect(specs[1]).not.toHaveProperty("steps");
});

test("the system prompt is the fenced role prompt, with notes outside the fence", () => {
  const [spec] = agentSpecs({ grunts: { "a/b": { notes: "keep it short" } } }, io);
  expect(spec.system.startsWith(`${promptOpen("grunt")}\nthe grunt prompt\n${PROMPT_CLOSE}`)).toBe(
    true,
  );
  expect(spec.system.indexOf(PROMPT_CLOSE)).toBeLessThan(spec.system.indexOf(NOTES_OPEN));
  expect(spec.system).toContain(`${NOTES_OPEN}\nkeep it short\n${NOTES_CLOSE}`);
  expect(isSquadSystem(spec.system)).toBe(true);
});

test("an unreadable role prompt falls back to the placeholder, still fenced", () => {
  const [spec] = agentSpecs({ drills: { "a/b": {} } }, { ...io, prompt: () => null });
  expect(isSquadSystem(spec.system)).toBe(true);
  expect(spec.system).toContain("squad prompt missing");
});

test("a disabled entry stays in the roster but registers no agent; blank variant is none", () => {
  const specs = agentSpecs({ grunts: { "a/b": { disable: true }, "c/d": { variant: "  " } } }, io);
  expect(specs.map((s) => s.id)).toEqual(["grunt-c-d"]);
  expect(specs[0].model).toEqual({ providerID: "c", id: "d" });
});

/** A fake host editor over a Map of agents. */
function editorOf(agents) {
  const map = new Map(agents.map((a) => [a.id, structuredClone(a)]));
  return {
    map,
    list: () => [...map.values()],
    get: (id) => map.get(id),
    remove: (id) => map.delete(id),
    update: (id, f) => {
      const agent = map.get(id) ?? {
        id,
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      };
      f(agent);
      map.set(id, agent);
    },
  };
}

test("early: creates each agent with every squad field and the role rules", () => {
  const specs = agentSpecs({ drills: { "a/b": { variant: "max" } } }, io);
  const editor = editorOf([]);
  earlyTransform(editor, specs);
  const agent = editor.get("drill-a-b");
  expect(agent).toMatchObject({
    mode: "subagent",
    hidden: true,
    description: "drill on a/b",
    model: { providerID: "a", id: "b", variant: "max" },
  });
  expect(agent.permissions.slice(1)).toEqual(roleRules("drill"));
});

test("late: role rules go last, after whatever the config plugin appended", () => {
  const specs = agentSpecs({ drills: { "a/b": {} } }, io);
  const editor = editorOf([]);
  earlyTransform(editor, specs);
  // The config-agent plugin appends the user's global rules after ours.
  editor.get("drill-a-b").permissions.push({ action: "*", resource: "*", effect: "allow" });
  lateTransform(editor, specs);
  expect(editor.get("drill-a-b").permissions.slice(-roleRules("drill").length)).toEqual(
    roleRules("drill"),
  );
});

test("late: a same-id legacy generated file is taken over, its own fields cleared", () => {
  const specs = agentSpecs({ grunts: { "a/b": {} } }, io);
  const legacy = {
    id: "grunt-a-b",
    system: `${promptOpen("grunt")}\nold\n${PROMPT_CLOSE}`,
    description: "old",
    color: "#ff0000",
    steps: 7,
    permissions: [],
  };
  const editor = editorOf([legacy]);
  const report = lateTransform(editor, specs);
  expect(report).toEqual({ foreign: [], hidden: [], stray: [] });
  const agent = editor.get("grunt-a-b");
  expect(agent.system).toContain("the grunt prompt");
  expect(agent.description).toBe("grunt on a/b");
  expect(agent).not.toHaveProperty("color");
  expect(agent).not.toHaveProperty("steps");
});

test("late: a hand-authored agent with a roster id is left alone and reported", () => {
  const specs = agentSpecs({ grunts: { "a/b": {} } }, io);
  const mine = { id: "grunt-a-b", system: "My own prompt.", description: "mine", permissions: [] };
  const editor = editorOf([mine]);
  expect(lateTransform(editor, specs)).toEqual({ foreign: ["grunt-a-b"], hidden: [], stray: [] });
  expect(editor.get("grunt-a-b")).toEqual(mine);
});

test("late: verified legacy agents the roster dropped are hidden, worker- included; nothing else is", () => {
  const fenced = `${promptOpen("drill")}\nx\n${PROMPT_CLOSE}`;
  const editor = editorOf([
    { id: "drill-old-model", system: fenced, permissions: [] },
    // Generated before the fence existed: only the marker-verified set knows it.
    { id: "worker-old-model", system: "an old inlined prompt", permissions: [] },
    { id: "drill-hand-written", system: "mine", permissions: [] },
    // Fenced, but from a project's own agent dir: not verified as ours.
    { id: "drill-project-model", system: fenced, permissions: [] },
    { id: "build", system: fenced, permissions: [] },
  ]);
  const report = lateTransform(
    editor,
    agentSpecs({ grunts: { "a/b": {} } }, io),
    new Set(["drill-old-model", "worker-old-model"]),
  );
  expect(report).toEqual({
    foreign: [],
    hidden: ["drill-old-model", "worker-old-model"],
    stray: ["drill-project-model"],
  });
  expect([...editor.map.keys()].sort()).toEqual([
    "build",
    "drill-hand-written",
    "drill-project-model",
    "grunt-a-b",
  ]);
});

test("late: a pre-fence legacy file with a roster id is taken over, not foreign", () => {
  const editor = editorOf([
    { id: "grunt-a-b", system: "old inlined grunt prompt", permissions: [] },
  ]);
  const report = lateTransform(
    editor,
    agentSpecs({ grunts: { "a/b": {} } }, io),
    new Set(["grunt-a-b"]),
  );
  expect(report.foreign).toEqual([]);
  expect(editor.get("grunt-a-b").system).toContain("the grunt prompt");
});
