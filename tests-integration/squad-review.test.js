// Suite: the review findings on #86 (#87, #88) reproduced on the real
// OpenCode 2.1.3 host with TestLLM, each the way the reviewer ran it.
//   #87  a drill's very first request, in a session started directly for it,
//        offers only the drill's tools and enforces its rules;
//   #88  an agent the user wrote keeps its whole effective definition when the
//        roster asks for its id, or when a verified legacy file shares its id.
// Run: npm run test:integration   (Node >= 24)

import fs from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, expect, test } from "vitest";
import { model, TestLLM, withHost } from "./host.js";

const configDir = () => path.join(process.env.XDG_CONFIG_HOME ?? "", "opencode");
const storeFile = () => path.join(configDir(), "squad.json");
afterEach(async () => {
  await fs.rm(storeFile(), { force: true });
  await fs.rm(path.join(configDir(), "agent"), { recursive: true, force: true });
});

/** @param {object} roster */
async function writeRoster(roster) {
  await fs.mkdir(configDir(), { recursive: true });
  await fs.writeFile(
    storeFile(),
    JSON.stringify({ version: 1, grunts: {}, drills: {}, ...roster }),
  );
}

const isTitleRequest = (request) => (request.tools ?? []).length === 0;
const toolName = (t) => t.name ?? t.function?.name ?? "";
const GLOBAL_ALLOW = { permissions: [{ action: "*", resource: "*", effect: "allow" }] };

/** One plain turn in a build session, so the host has served a request. */
const oneTurn = (h) =>
  Effect.gen(function* () {
    const session = yield* h.opencode.sessions.create({ location: h.location, model: model.ref });
    yield* h.opencode.sessions.prompt({ sessionID: session.id, text: "PARENT-ASK" });
    yield* h.opencode.sessions.wait({ sessionID: session.id }).pipe(Effect.timeout("45 seconds"));
  });

/** The live definition of one agent, or undefined. */
const liveAgent = (h, id) =>
  h.opencode.agent
    .list({ location: { directory: h.project } })
    .pipe(Effect.map((out) => out.data.find((a) => a.id === id)));

test("#87: the first request of a session started directly for a drill offers only drill tools", async () => {
  await writeRoster({ drills: { "p/m": {} } });
  const requests = [];
  const out = await withHost(
    (h) =>
      Effect.gen(function* () {
        yield* h.llm.serve((request) => {
          if (isTitleRequest(request)) return TestLLM.text("Title", "title");
          const body = JSON.stringify(request.messages ?? request);
          requests.push((request.tools ?? []).map(toolName));
          if (!body.includes("c-rm")) return TestLLM.tool("c-rm", "shell", { command: "rm -rf x" });
          return TestLLM.text("done", "answer");
        });
        const session = yield* h.opencode.sessions.create({
          location: h.location,
          model: model.ref,
          agent: "drill-p-m",
        });
        yield* h.opencode.sessions.prompt({ sessionID: session.id, text: "CHILD-DRILL" });
        yield* h.opencode.sessions
          .wait({ sessionID: session.id })
          .pipe(Effect.timeout("45 seconds"));
        const context = yield* h.opencode.sessions.context({ sessionID: session.id });
        return { context, resolved: h.resolved };
      }),
    GLOBAL_ALLOW,
  );
  expect(out.resolved.map((s) => s.agent)).toContain("drill-p-m");
  expect(requests.length).toBeGreaterThan(0);
  const first = requests[0];
  expect(first).toEqual(expect.arrayContaining(["read", "shell"]));
  for (const denied of ["edit", "write", "patch", "execute", "subagent"])
    expect(first).not.toContain(denied);
  const rm = out.context
    .flatMap((m) => m.content ?? [])
    .find((p) => p.type === "tool" && p.id === "c-rm")?.state;
  expect(JSON.stringify(rm)).toContain("permission.rejected");
}, 120_000);

/** A hand-written agent file: its own prompt, no model, no hidden. */
const HAND = "---\ndescription: mine\nmode: subagent\n---\nHAND-WRITTEN PROMPT\n";

/** The agent's definition as the host builds it with the given roster. */
async function definitionWith(roster, id, files) {
  if (roster) await writeRoster(roster);
  else await fs.rm(storeFile(), { force: true });
  return withHost(
    (h) =>
      Effect.gen(function* () {
        yield* h.llm.serve((request) =>
          isTitleRequest(request) ? TestLLM.text("Title", "title") : TestLLM.text("ok", "answer"),
        );
        yield* oneTurn(h);
        return yield* liveAgent(h, id);
      }),
    GLOBAL_ALLOW,
    { prepare: files },
  );
}

test("#88: a hand-authored agent holding a roster id keeps its whole effective definition", async () => {
  const files = async (project) => {
    await fs.mkdir(path.join(project, "agent"), { recursive: true });
    await fs.writeFile(path.join(project, "agent", "drill-p-foreign.md"), HAND);
  };
  const alone = await definitionWith({}, "drill-p-foreign", files);
  const claimed = await definitionWith({ drills: { "p/foreign": {} } }, "drill-p-foreign", files);
  expect(alone?.system).toContain("HAND-WRITTEN PROMPT");
  expect(claimed).toEqual(alone);
}, 180_000);

/** An agent file as versions before #85 generated it. */
const legacy = (role, modelId) =>
  [
    "---",
    "# generated-by: opencode-squad squad-draft",
    'description: "stale description"',
    "mode: subagent",
    `model: ${modelId}`,
    "---",
    "",
    `<!-- squad:prompt role=${role} -->`,
    "stale body",
    "<!-- /squad:prompt -->",
    "",
  ].join("\n");

test("#88: a verified legacy file does not hide another agent the host loaded at its id", async () => {
  const files = async (project) => {
    // Ours, verified by its marker, in the global agent dir...
    await fs.mkdir(path.join(configDir(), "agent"), { recursive: true });
    await fs.writeFile(path.join(configDir(), "agent", "drill-old-m.md"), legacy("drill", "old/m"));
    // ...while the host loads the user's own agent at the same id.
    await fs.mkdir(path.join(project, "agent"), { recursive: true });
    await fs.writeFile(path.join(project, "agent", "drill-old-m.md"), HAND);
  };
  const alone = await definitionWith(null, "drill-old-m", async (project) => {
    await files(project);
    // A store that does not parse: the plugin registers and hides nothing.
    await fs.writeFile(storeFile(), "{");
  });
  const live = await definitionWith({}, "drill-old-m", files);
  expect(alone?.system).toContain("HAND-WRITTEN PROMPT");
  expect(live).toEqual(alone);
}, 180_000);
