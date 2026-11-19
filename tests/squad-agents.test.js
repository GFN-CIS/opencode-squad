// Suite: src/squad-agents.js — the agents a roster registers, id collisions,
// the early (probe) and late agent transforms against a fake host editor, and
// the per-request tool check. The real host order is covered by
// tests-integration/squad-agents.test.js and squad-review.test.js.
// Run: npx vitest run tests/squad-agents.test.js

import { expect, test } from "vitest";
import { PROMPT_CLOSE, promptOpen } from "../src/prompt-inject.js";
import { NOTES_CLOSE, NOTES_OPEN } from "../src/roster.js";
import {
  agentSpecs,
  deniedTools,
  earlyTransform,
  endsWithRoleRules,
  isSquadSystem,
  lateTransform,
  PROBE_ID,
  rosterCollisions,
} from "../src/squad-agents.js";
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

test("model ids that map to one agent id collide: neither is registered (#90)", () => {
  const roster = {
    grunts: { "p/m-1": {}, "p/m.1": { variant: "high" }, "q/r": {} },
    drills: { "p/m-1": {} },
  };
  expect(rosterCollisions(roster)).toEqual([
    { id: "grunt-p-m-1", entries: ["grunt p/m-1", "grunt p/m.1"] },
  ]);
  expect(agentSpecs(roster, io).map((s) => s.id)).toEqual(["grunt-q-r", "drill-p-m-1"]);
  // A disabled entry still holds its id: enabling it later would collide.
  expect(rosterCollisions({ grunts: { "p/m-1": {}, "p/m.1": { disable: true } } })).toHaveLength(1);
});

const GLOBAL = { action: "*", resource: "*", effect: "allow" };

/**
 * A fake host editor over a Map of agents. `hostOrder` runs the transforms
 * the way the host does: ours early, the config-agent plugin (global rules to
 * every agent, then file agents on top), ours late.
 */
function editorOf(agents) {
  const map = new Map(agents.map((a) => [a.id, structuredClone(a)]));
  return {
    map,
    list: () => [...map.values()],
    get: (id) => map.get(id),
    remove: (id) => map.delete(id),
    update: (id, f) => {
      const agent = map.get(id) ?? { id, permissions: [] };
      f(agent);
      map.set(id, agent);
    },
  };
}

/** @param {{files?: any[], specs: any[], legacy?: Map<string, any>, globals?: any[]}} run */
function hostOrder({ files = [], specs, legacy, globals = [GLOBAL] }) {
  const editor = editorOf([]);
  earlyTransform(editor);
  for (const a of editor.list()) a.permissions.push(...globals.map((r) => ({ ...r })));
  for (const file of files) {
    editor.update(file.id, (a) => {
      Object.assign(a, structuredClone({ ...file, permissions: undefined }));
      a.permissions = [...(a.permissions ?? []), ...globals, ...(file.permissions ?? [])];
    });
  }
  const report = lateTransform(editor, specs, legacy);
  return { editor, report };
}

test("early: only the probe, which cannot be dispatched or selected", () => {
  const editor = editorOf([]);
  earlyTransform(editor);
  expect(editor.list().map((a) => a.id)).toEqual([PROBE_ID]);
  const probe = editor.get(PROBE_ID);
  // The subagent tool refuses a primary agent; a hidden one is never selected.
  expect(probe).toMatchObject({ mode: "primary", hidden: true, system: "" });
  expect(probe.permissions[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
});

test("late: built from a fresh default — global rules, then role rules last; probe removed", () => {
  const specs = agentSpecs({ drills: { "a/b": { variant: "max" } } }, io);
  const { editor } = hostOrder({ specs });
  expect(editor.get(PROBE_ID)).toBeUndefined();
  expect(editor.get("drill-a-b")).toEqual({
    id: "drill-a-b",
    mode: "subagent",
    hidden: true,
    description: "drill on a/b",
    system: specs[0].system,
    model: { providerID: "a", id: "b", variant: "max" },
    permissions: [GLOBAL, ...roleRules("drill")],
  });
  expect(endsWithRoleRules(editor.get("drill-a-b"), "drill")).toBe(true);
});

test("late: without the probe there are no global rules to copy, and nothing breaks", () => {
  const editor = editorOf([]);
  lateTransform(editor, agentSpecs({ grunts: { "a/b": {} } }, io));
  expect(editor.get("grunt-a-b").permissions).toEqual(roleRules("grunt"));
});

/** A legacy generated file as the host loads it, and as readLegacySquad saw it. */
const legacyFile = (id, modelId, system) => {
  const [providerID, ...rest] = modelId.split("/");
  return {
    live: {
      id,
      system,
      description: "stale",
      color: "#ff0000",
      steps: 7,
      model: { providerID, id: rest.join("/") },
      permissions: [{ action: "edit", resource: "*", effect: "allow" }],
    },
    seen: [id, { id, system, modelId }],
  };
};

test("late: a same-id legacy file is rebuilt from scratch, none of its fields kept", () => {
  const specs = agentSpecs({ drills: { "a/b": {} } }, io);
  const old = legacyFile("drill-a-b", "a/b", "an old inlined prompt");
  const { editor, report } = hostOrder({ specs, files: [old.live], legacy: new Map([old.seen]) });
  expect(report).toEqual({ foreign: [], hidden: [], stray: [], kept: [] });
  const agent = editor.get("drill-a-b");
  expect(agent).not.toHaveProperty("color");
  expect(agent).not.toHaveProperty("steps");
  expect(agent.permissions).toEqual([GLOBAL, ...roleRules("drill")]);
});

test("late: a hand-authored agent with a roster id is left exactly as the host built it (#88)", () => {
  const specs = agentSpecs({ drills: { "p/foreign": {} } }, io);
  const mine = { id: "drill-p-foreign", system: "My own prompt.", description: "mine" };
  const alone = hostOrder({ specs: [], files: [mine] }).editor.get("drill-p-foreign");
  const { editor, report } = hostOrder({ specs, files: [mine] });
  expect(report.foreign).toEqual(["drill-p-foreign"]);
  expect(editor.get("drill-p-foreign")).toEqual(alone);
});

test("late: a verified legacy id held by another agent is neither hidden nor taken over (#88)", () => {
  const old = legacyFile("drill-old-m", "old/m", "stale body");
  const mine = { id: "drill-old-m", system: "My own prompt.", model: old.live.model };
  const dropped = hostOrder({ specs: [], files: [mine], legacy: new Map([old.seen]) });
  expect(dropped.report.kept).toEqual(["drill-old-m"]);
  expect(dropped.editor.get("drill-old-m").system).toBe("My own prompt.");
  const claimed = hostOrder({
    specs: agentSpecs({ drills: { "old/m": {} } }, io),
    files: [mine],
    legacy: new Map([old.seen]),
  });
  expect(claimed.report.foreign).toEqual(["drill-old-m"]);
  expect(claimed.editor.get("drill-old-m").system).toBe("My own prompt.");
});

test("late: verified legacy agents the roster dropped are hidden, worker- included; nothing else is", () => {
  const fenced = `${promptOpen("drill")}\nx\n${PROMPT_CLOSE}`;
  const drill = legacyFile("drill-old-model", "o/d", fenced);
  // Generated before the fence existed: only the marker-verified set knows it.
  const worker = legacyFile("worker-old-model", "o/w", "an old inlined prompt");
  const { editor, report } = hostOrder({
    specs: agentSpecs({ grunts: { "a/b": {} } }, io),
    files: [
      drill.live,
      worker.live,
      { id: "drill-hand-written", system: "mine" },
      // Fenced, but from a project's own agent dir: not verified as ours.
      { id: "drill-project-model", system: fenced },
      { id: "build", system: fenced },
    ],
    legacy: new Map([drill.seen, worker.seen]),
  });
  expect(report).toEqual({
    foreign: [],
    hidden: ["drill-old-model", "worker-old-model"],
    stray: ["drill-project-model"],
    kept: [],
  });
  expect([...editor.map.keys()].sort()).toEqual([
    "build",
    "drill-hand-written",
    "drill-project-model",
    "grunt-a-b",
  ]);
});

test("a legacy file matches the live agent across CRLF and surrounding blank lines", () => {
  const old = legacyFile("grunt-a-b", "a/b", "line one\nline two");
  const { report } = hostOrder({
    specs: agentSpecs({ grunts: { "a/b": {} } }, io),
    files: [{ ...old.live, system: "\nline one\r\nline two\n" }],
    legacy: new Map([old.seen]),
  });
  expect(report.foreign).toEqual([]);
});

test("endsWithRoleRules: global rules appended after the role's are caught", () => {
  const agent = { permissions: [...roleRules("drill")] };
  expect(endsWithRoleRules(agent, "drill")).toBe(true);
  agent.permissions.push(GLOBAL);
  expect(endsWithRoleRules(agent, "drill")).toBe(false);
  expect(endsWithRoleRules({}, "grunt")).toBe(false);
});

test("deniedTools: the host's whole-tool test, under the tool's permission action", () => {
  const names = ["read", "shell", "edit", "write", "execute", "webfetch"];
  const actions = new Map([["write", "edit"]]);
  expect(deniedTools(names, [GLOBAL, ...roleRules("drill")], actions)).toEqual([
    "edit",
    "write",
    "execute",
  ]);
  // A pattern on the resource is not a whole-tool deny: shell stays for git.
  expect(deniedTools(["shell"], [{ action: "shell", resource: "rm *", effect: "deny" }])).toEqual(
    [],
  );
  expect(deniedTools(["question"], [{ action: "q*", resource: "*", effect: "deny" }])).toEqual([
    "question",
  ]);
  expect(deniedTools(names, [GLOBAL, ...roleRules("grunt")], actions)).toEqual([]);
});
