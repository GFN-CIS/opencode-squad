// Suite: squad agents registered by the plugin from squad.json, in the real
// OpenCode 2.1.3 host, offline (#85). The roster file is in the run's
// XDG config dir (setup.js); the project is the host's config dir, so
// `<project>/agent/*.md` are agent files the host loads by itself.
// Run: npm run test:integration   (Node >= 24)

import fs from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, expect, test } from "vitest";
import { promptOpen } from "../src/prompt-inject.js";
import { storeRevision } from "../src/squad-store.js";
import { model, TestLLM, withHost } from "./host.js";

const storeFile = () => path.join(process.env.XDG_CONFIG_HOME ?? "", "opencode", "squad.json");
afterEach(async () => {
  await fs.rm(storeFile(), { force: true });
  await fs.rm(path.join(path.dirname(storeFile()), "agent"), { recursive: true, force: true });
});

/** @param {object} roster */
async function writeRoster(roster) {
  await fs.mkdir(path.dirname(storeFile()), { recursive: true });
  await fs.writeFile(storeFile(), JSON.stringify({ version: 1, ...roster }));
}

/** An agent file as versions before #85 generated it. */
const legacy = (role, model, extra = "") =>
  [
    "---",
    "# generated-by: opencode-squad squad-draft",
    'description: "stale description"',
    "mode: subagent",
    `model: ${model}`,
    extra,
    "---",
    "",
    `<!-- squad:prompt role=${role} -->`,
    "stale body",
    "<!-- /squad:prompt -->",
    "",
  ].join("\n");

/** A file generated before the role-prompt fence existed: the prompt inline. */
const preFence = (model) =>
  [
    "---",
    "# generated-by: opencode-orchestrate generating-model-workers",
    'description: "stale description"',
    "mode: subagent",
    `model: ${model}`,
    "---",
    "",
    "You are a worker. (An old inlined prompt.)",
    "",
  ].join("\n");

const isTitleRequest = (request) => (request.tools ?? []).length === 0;
const toolName = (t) => t.name ?? t.function?.name ?? "";
const callTool = (id, name, input) => TestLLM.tool(id, name, input);
const code = (id, js) => TestLLM.tool(id, "execute", { code: js });

/** The tool part a parent call produced. */
const toolState = (context, id) =>
  context.flatMap((m) => m.content ?? []).find((p) => p.type === "tool" && p.id === id)?.state;

// The user's global rule allows everything: the squad's own rules must still
// decide for its agents.
const GLOBAL_ALLOW = { permissions: [{ action: "*", resource: "*", effect: "allow" }] };

test("FR-001, FR-003, FR-013, FR-016, FR-021: the squad is registered from squad.json: dispatch, drill policy, legacy agents, live patch", async () => {
  await writeRoster({ grunts: { "p/m": { variant: "high" } }, drills: { "p/m": {} } });
  const revision = storeRevision(storeFile());
  const children = {};
  const out = await withHost(
    (h) =>
      Effect.gen(function* () {
        let turn = 0;
        yield* h.llm.serve((request) => {
          if (isTitleRequest(request)) return TestLLM.text("Title", "title");
          const body = JSON.stringify(request.messages ?? request);
          const child = /CHILD-[A-Z-]+/.exec(body)?.[0];
          if (child && !body.includes("PARENT-ASK")) {
            children[child] ??= {
              tools: (request.tools ?? []).map(toolName),
              system: JSON.stringify(request.system ?? null),
            };
            if (child === "CHILD-DRILL") {
              if (!body.includes("c-rm")) return callTool("c-rm", "shell", { command: "rm -rf x" });
              if (!body.includes("c-gl"))
                return callTool("c-gl", "shell", { command: "git log -1" });
              children[child].results = body.slice(body.indexOf("c-rm"));
            }
            return TestLLM.text(`${child} done`, "answer");
          }
          turn++;
          if (turn === 1) return code("p-dump", "return await tools.squad_dump({})");
          if (turn === 2)
            return callTool("p-drill", "subagent", {
              agent: "drill-p-m",
              description: "review",
              prompt: "CHILD-DRILL",
            });
          if (turn === 3)
            return callTool("p-ghost", "subagent", {
              agent: "drill-old-m",
              description: "old",
              prompt: "CHILD-GHOST",
            });
          if (turn === 4)
            return callTool("p-worker", "subagent", {
              agent: "worker-old-w",
              description: "old",
              prompt: "CHILD-WORKER",
            });
          if (turn === 5)
            return code(
              "p-patch",
              `return await tools.squad_patch({revision: "${revision}", grunts: {"p/m": {variant: "high"}, "p/n": {}}, drills: {"p/m": {}}})`,
            );
          if (turn === 6)
            return callTool("p-new", "subagent", {
              agent: "grunt-p-n",
              description: "new",
              prompt: "CHILD-NEW",
            });
          return TestLLM.text("parent done", "answer");
        });
        const session = yield* h.opencode.sessions.create({
          location: h.location,
          model: model.ref,
        });
        yield* h.opencode.sessions.prompt({ sessionID: session.id, text: "PARENT-ASK" });
        yield* h.opencode.sessions
          .wait({ sessionID: session.id })
          .pipe(Effect.timeout("60 seconds"));
        const context = yield* h.opencode.sessions.context({ sessionID: session.id });
        return { context, resolved: h.resolved };
      }),
    GLOBAL_ALLOW,
    {
      prepare: async (project) => {
        // In a real install the host loads agents from the same global dir the
        // plugin verifies legacy files in; here the host's config dir is the
        // project, so the files go to both.
        const files = {
          // The same id as a roster agent, with fields the squad does not set.
          "grunt-p-m.md": legacy("grunt", "p/m", 'steps: 3\ncolor: "#ff0000"'),
          // A legacy agent the roster no longer has.
          "drill-old-m.md": legacy("drill", "old/m"),
          // Generated before the role-prompt fence existed: no fence at all.
          "worker-old-w.md": preFence("old/w"),
        };
        for (const dir of [
          path.join(project, "agent"),
          path.join(path.dirname(storeFile()), "agent"),
        ]) {
          await fs.mkdir(dir, { recursive: true });
          for (const [name, text] of Object.entries(files))
            await fs.writeFile(path.join(dir, name), text);
        }
      },
    },
  );

  // squad_dump reads the roster from squad.json.
  const dump = JSON.stringify(toolState(out.context, "p-dump"));
  expect(dump).toContain(`Squad roster: ${storeFile()}`);
  expect(dump).toContain('\\"p/m\\"');

  // The drill: dispatched with its model, its role prompt, and read-only tools
  // only, although the user's global rule allows everything.
  const drillRun = out.resolved.find((s) => s.agent === "drill-p-m");
  expect(drillRun?.model).toMatchObject({ providerID: "p", id: "m" });
  const drill = children["CHILD-DRILL"];
  expect(drill.system).toContain(promptOpen("drill").replaceAll('"', '\\"'));
  expect(drill.tools).toEqual(expect.arrayContaining(["read", "shell"]));
  for (const denied of ["edit", "write", "execute", "subagent"])
    expect(drill.tools).not.toContain(denied);
  expect(drill.results).toMatch(/"id":"c-rm".{0,200}permission\.rejected/);
  expect(drill.results).not.toMatch(/"id":"c-gl".{0,200}permission\.rejected/);

  // Legacy agents the roster dropped are not dispatchable, a pre-fence
  // worker- included.
  expect(toolState(out.context, "p-ghost")?.status).toBe("error");
  expect(children["CHILD-GHOST"]).toBeUndefined();
  expect(toolState(out.context, "p-worker")?.status).toBe("error");
  expect(children["CHILD-WORKER"]).toBeUndefined();

  // squad_patch: written to squad.json, live on the next dispatch.
  expect(JSON.stringify(toolState(out.context, "p-patch"))).toContain("+1 added");
  const stored = JSON.parse(await fs.readFile(storeFile(), "utf8"));
  expect(Object.keys(stored.grunts)).toEqual(["p/m", "p/n"]);
  const newRun = out.resolved.find((s) => s.agent === "grunt-p-n");
  expect(newRun?.model).toMatchObject({ providerID: "p", id: "n" });
  expect(children["CHILD-NEW"]).toBeDefined();
}, 120_000);

test("FR-010, FR-019: a hand-authored agent holding a roster id keeps its own prompt, and squad_patch refuses that id", async () => {
  await writeRoster({ grunts: { "p/q": {} }, drills: {} });
  const revision = storeRevision(storeFile());
  const children = {};
  const out = await withHost(
    (h) =>
      Effect.gen(function* () {
        let turn = 0;
        yield* h.llm.serve((request) => {
          if (isTitleRequest(request)) return TestLLM.text("Title", "title");
          const body = JSON.stringify(request.messages ?? request);
          if (body.includes("CHILD-HAND") && !body.includes("PARENT-ASK")) {
            children.hand ??= JSON.stringify(request.system ?? null);
            return TestLLM.text("hand done", "answer");
          }
          turn++;
          if (turn === 1) return code("p-dump", "return await tools.squad_dump({})");
          if (turn === 2)
            return callTool("p-hand", "subagent", {
              agent: "grunt-p-q",
              description: "hand",
              prompt: "CHILD-HAND",
            });
          if (turn === 3)
            return code(
              "p-patch",
              `return await tools.squad_patch({revision: "${revision}", grunts: {"p/q": {variant: "high"}}})`,
            );
          return TestLLM.text("parent done", "answer");
        });
        const session = yield* h.opencode.sessions.create({
          location: h.location,
          model: model.ref,
        });
        yield* h.opencode.sessions.prompt({ sessionID: session.id, text: "PARENT-ASK" });
        yield* h.opencode.sessions
          .wait({ sessionID: session.id })
          .pipe(Effect.timeout("60 seconds"));
        return { context: yield* h.opencode.sessions.context({ sessionID: session.id }) };
      }),
    GLOBAL_ALLOW,
    {
      prepare: async (project) => {
        await fs.mkdir(path.join(project, "agent"));
        await fs.writeFile(
          path.join(project, "agent", "grunt-p-q.md"),
          "---\ndescription: mine\nmode: subagent\n---\nHAND-WRITTEN PROMPT\n",
        );
      },
    },
  );
  expect(JSON.stringify(toolState(out.context, "p-dump"))).toContain(
    "grunt-p-q: a hand-authored agent holds this id",
  );
  expect(children.hand).toContain("HAND-WRITTEN PROMPT");
  expect(children.hand).not.toContain("squad:prompt");
  const patch = JSON.stringify(toolState(out.context, "p-patch"));
  expect(patch).toContain(
    "REFUSED: the roster asks for an agent id that a hand-authored agent already holds",
  );
  expect(JSON.parse(await fs.readFile(storeFile(), "utf8")).grunts).toEqual({ "p/q": {} });
}, 120_000);
