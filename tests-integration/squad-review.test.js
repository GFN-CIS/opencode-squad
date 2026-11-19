// Suite: the review findings on #86 (#87, #88) reproduced on the real
// OpenCode 2.1.3 host with TestLLM, each the way the reviewer ran it.
//   #87  a drill's very first request, in a session started directly for it,
//        offers only the drill's tools and enforces its rules;
//   #88  an agent the user wrote keeps its whole effective definition when the
//        roster asks for its id, or when a verified legacy file shares its id.
//   #92  a roster replaced with equal size and mtime still takes effect on
//        the next request;
//   #91  an unreadable model_data.json never registers a squad agent whose
//        description silently lacks the owner's rules.
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

/** An agent file exactly as the last file-writing version (0.5) generated it. */
const legacy = (role, modelId) =>
  [
    "---",
    "# generated-by: opencode-squad squad-draft",
    'description: "stale description"',
    "mode: subagent",
    `model: ${modelId}`,
    "hidden: true",
    "permissions:",
    '  - {"action":"edit","resource":"*","effect":"deny"}',
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

test("#91: with model_data.json unreadable, the live description says the owner rules are unknown", async () => {
  await writeRoster({ grunts: { "p/m": {} } });
  // The owner's rule is in there, but the file does not parse.
  await fs.writeFile(
    path.join(configDir(), "model_data.json"),
    '{"models": {"p/m": {"info": "no secrets"}},',
  );
  try {
    const live = await withHost(
      (h) =>
        Effect.gen(function* () {
          yield* h.llm.serve((request) =>
            isTitleRequest(request) ? TestLLM.text("Title", "title") : TestLLM.text("ok", "answer"),
          );
          yield* oneTurn(h);
          return yield* liveAgent(h, "grunt-p-m");
        }),
      GLOBAL_ALLOW,
    );
    expect(live?.description).toContain("Owner rules UNKNOWN");
    expect(live?.description).toContain("model_data.json could not be read");
  } finally {
    await fs.rm(path.join(configDir(), "model_data.json"), { force: true });
  }
}, 120_000);

test("#92: an equal-size roster with the old mtime still takes effect on the next request", async () => {
  await writeRoster({ grunts: { "p/m": { variant: "low" } } });
  // A whole second, so it can be put back exactly.
  const stamp = new Date("2026-01-01T00:00:00Z");
  await fs.utimes(storeFile(), stamp, stamp);
  const live = await withHost(
    (h) =>
      Effect.gen(function* () {
        yield* h.llm.serve((request) =>
          isTitleRequest(request) ? TestLLM.text("Title", "title") : TestLLM.text("ok", "answer"),
        );
        yield* oneTurn(h);
        const before = (yield* liveAgent(h, "grunt-p-m"))?.model?.variant;
        // Another process swaps in an equally long roster, and the
        // timestamp ends up where it was.
        yield* Effect.promise(async () => {
          const text = (await fs.readFile(storeFile(), "utf8")).replace('"low"', '"max"');
          await fs.writeFile(`${storeFile()}.tmp`, text);
          await fs.rename(`${storeFile()}.tmp`, storeFile());
          await fs.utimes(storeFile(), stamp, stamp);
        });
        yield* oneTurn(h);
        return { before, after: (yield* liveAgent(h, "grunt-p-m"))?.model?.variant };
      }),
    GLOBAL_ALLOW,
  );
  expect(live).toEqual({ before: "low", after: "max" });
}, 120_000);

test("#88: a project agent with the legacy file's model and prompt but its own fields is left alone", async () => {
  const mine = legacy("drill", "old/m#high").replace('"stale description"', '"mine"');
  const files = async (project) => {
    await fs.mkdir(path.join(configDir(), "agent"), { recursive: true });
    await fs.writeFile(path.join(configDir(), "agent", "drill-old-m.md"), legacy("drill", "old/m"));
    await fs.mkdir(path.join(project, "agent"), { recursive: true });
    await fs.writeFile(path.join(project, "agent", "drill-old-m.md"), mine);
  };
  const alone = await definitionWith(null, "drill-old-m", async (project) => {
    await files(project);
    await fs.writeFile(storeFile(), "{");
  });
  expect(alone).toMatchObject({ description: "mine", model: { variant: "high" } });
  expect(await definitionWith({}, "drill-old-m", files)).toEqual(alone);
}, 180_000);

test("#88: the plugin still recognises its own legacy file: hidden with an empty roster", async () => {
  const files = async (project) => {
    for (const dir of [path.join(configDir(), "agent"), path.join(project, "agent")]) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "drill-old-m.md"), legacy("drill", "old/m#high"));
    }
  };
  const alone = await definitionWith(null, "drill-old-m", async (project) => {
    await files(project);
    await fs.writeFile(storeFile(), "{");
  });
  expect(alone?.model).toMatchObject({ providerID: "old", id: "m", variant: "high" });
  expect(await definitionWith({}, "drill-old-m", files)).toBeUndefined();
}, 180_000);

test("#88: a hand-authored agent named like the plugin's probe is left intact", async () => {
  const files = async (project) => {
    await fs.mkdir(path.join(project, "agent"), { recursive: true });
    await fs.writeFile(path.join(project, "agent", "opencode-squad-probe.md"), HAND);
  };
  const alone = await definitionWith(null, "opencode-squad-probe", async (project) => {
    await files(project);
    await fs.writeFile(storeFile(), "{");
  });
  expect(alone?.system).toContain("HAND-WRITTEN PROMPT");
  expect(await definitionWith({}, "opencode-squad-probe", files)).toEqual(alone);
}, 180_000);
