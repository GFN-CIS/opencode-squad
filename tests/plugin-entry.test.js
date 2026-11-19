// Suite: the package entry (index.js → .opencode/lib/squad.js) as an
// OpenCode 2 host sees it. Covers setup registering the squad_* tools,
// squad_patch writing squad.json and registering the agents through the
// host's agent transforms (#85), and squad_metrics rendering
// host models + cached metrics, with the startup network refreshes stubbed at
// the runtime boundary. Not covered: live hook firing,
// rate-limit guard and skill loading — those need a real host or their own
// suites. Run: npx vitest run tests/plugin-entry.test.js

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import plugin from "../index.js";
import { defaultStoreFile, readStore } from "../src/squad-store.js";
import { roleRules } from "../src/workers.js";

// Startup refreshes write global model data and schedule network requests;
// leave tool registration and the filesystem generator real.
vi.mock("../.opencode/lib/runtime.js", async (importOriginal) => {
  const { indexModelIds, indexScoreRows, indexSuperIndex, LLMBENCH_FORMAT, SUPERINDEX_FORMAT } =
    await import("../src/metrics.js");
  const fx = (name) =>
    JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, "fixtures", "metrics", name), "utf8"),
    );
  const rows = fx("llmbench-scores.json");
  const data = {
    superindex: {
      fetchedAt: Date.now(),
      format: SUPERINDEX_FORMAT,
      index: indexSuperIndex(fx("superindex.json")),
    },
    scores: {
      fetchedAt: Date.now(),
      formatByMetric: Object.fromEntries(Object.keys(rows).map((m) => [m, LLMBENCH_FORMAT])),
      byMetric: Object.fromEntries(Object.entries(rows).map(([m, r]) => [m, indexScoreRows(r)])),
    },
    ids: {
      fetchedAt: Date.now(),
      format: LLMBENCH_FORMAT,
      index: indexModelIds([{ id: "z-ai/glm-5.3" }]),
    },
  };
  return {
    ...(await importOriginal()),
    ensureGlobalModelDataFresh: () => {},
    importLegacySquad: () => ({ imported: 0, problems: [] }),
    squadDescriber: () => (role, id) => `${role} on ${id}. Owner rule: no secrets.`,
    startMetricsRefresh: () => {},
    // A test may swap in its own cache contents.
    getMetrics: async () => globalThis.__squadMetricsData ?? data,
    loadModelSettings: () => ({
      models: {},
      providers: { "zai-coding-plan": "GLM Coding Pro" },
      found: true,
      problems: [],
    }),
    loadAuthTypes: () => ({}),
    METRICS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "squad-host-metrics-")),
  };
});

/**
 * plugin.setup against a minimal OpenCode 2 host with the guard off. Each
 * override replaces a whole host domain, so a test shows exactly what it feeds.
 *
 * @param {{directory: string} & Record<string, unknown>} host
 */
async function setupHost({ directory, agent, ...over }) {
  const tools = new Map();
  /** Agent transforms in registration order, as the host keeps them. */
  const transforms = [];
  /** @type {Map<string, (input: any) => unknown>} */
  const hooks = new Map();
  const dispose = await plugin.setup({
    location: { directory },
    options: { rate_limit_guard: { enabled: false } },
    skill: { transform: async () => {} },
    session: {
      hook: async (name, callback) => {
        hooks.set(name, callback);
      },
    },
    model: { list: async () => [] },
    tool: {
      hook: async () => {},
      transform: async (register) => register({ add: (tool) => tools.set(tool.name, tool) }),
    },
    agent: {
      list: async () => registered(),
      transform: async (callback) => {
        transforms.push(callback);
        return { dispose: async () => {} };
      },
      reload: async () => {},
      ...agent,
    },
    ...over,
  });
  /** The agent list the host would build: every transform over a fresh editor. */
  function registered() {
    const map = new Map();
    const editor = {
      list: () => [...map.values()],
      get: (id) => map.get(id),
      remove: (id) => map.delete(id),
      default: () => {},
      update: (id, f) => {
        const a = map.get(id) ?? { id, permissions: [] };
        f(a);
        map.set(id, a);
      },
    };
    for (const t of transforms) t(editor);
    return [...map.values()];
  }
  /** The first request: registers the late transform. */
  const firstRequest = () => hooks.get("context")?.({ agent: "build", system: [] });
  return { tools, dispose, registered, firstRequest };
}

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  // squad.json lives in the per-run config dir (tests/setup-isolation.js).
  fs.rmSync(defaultStoreFile(), { force: true });
});

test("package exposes only setup; squad_patch writes squad.json and registers the agents", async () => {
  expect(plugin.server).toBeUndefined();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "squad-host-"));
  dirs.push(directory);
  const input = {
    grunts: { "a/b": { variant: "high" } },
    drills: { "a/b": { variant: "max" } },
  };
  const { tools, dispose, registered, firstRequest } = await setupHost({ directory });
  let wrapped;
  let report;
  let scoped;
  try {
    await firstRequest();
    const patch = tools.get("squad_patch");
    // A roster wrapped one level too deep must not read as "delete everything".
    wrapped = (await patch.execute({ roster: input }, { agent: "build" })).content;
    scoped = (await patch.execute({ ...input, directory }, { agent: "build" })).content;
    report = (await patch.execute(input, { agent: "build" })).content;
  } finally {
    dispose();
  }
  expect([...tools.keys()]).toEqual(
    expect.arrayContaining([
      "squad_compact",
      "squad_dump",
      "squad_metrics",
      "squad_patch",
      "squad_session",
    ]),
  );
  expect(wrapped).toContain("Refused: pass `grunts` and/or `drills` at the TOP level");
  expect(wrapped).toContain("`roster`");
  expect(scoped).toContain("`directory` is no longer supported");
  expect(report).toContain("+2 added");
  expect(readStore(defaultStoreFile())).toEqual({ state: "ok", roster: input });
  // Nothing written next to the project, and no agent file anywhere.
  expect(fs.readdirSync(directory)).toEqual([]);
  const agents = registered();
  for (const [role, variant] of [
    ["grunt", "high"],
    ["drill", "max"],
  ]) {
    const agent = agents.find((a) => a.id === `${role}-a-b`);
    expect(agent).toMatchObject({
      mode: "subagent",
      hidden: true,
      description: `${role} on a/b. Owner rule: no secrets.`,
      model: { providerID: "a", id: "b", variant },
    });
    expect(agent.permissions.slice(-roleRules(role).length)).toEqual(roleRules(role));
  }
});

test("squad_metrics renders the asked models, squad roles and full detail", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "squad-host-"));
  dirs.push(directory);
  const detail = JSON.parse(
    fs.readFileSync(
      path.join(import.meta.dirname, "fixtures", "metrics", "llmbench-detail-glm-5.3.json"),
      "utf8",
    ),
  );
  const fetched = [];
  vi.stubGlobal("fetch", async (url) => {
    fetched.push(String(url));
    return { ok: true, status: 200, text: async () => JSON.stringify(detail) };
  });
  const { tools, dispose } = await setupHost({
    directory,
    agent: {
      list: async () => [
        {
          id: "grunt-zai-coding-plan-glm-5-3",
          mode: "subagent",
          model: { providerID: "zai-coding-plan", id: "glm-5.3" },
        },
      ],
    },
    model: {
      list: async () => [
        { providerID: "zai-coding-plan", id: "glm-5.3", limit: { context: 1_000_000 } },
        { providerID: "anthropic", id: "claude-sonnet-5-5" },
        { providerID: "opencode", id: "big-pickle" },
      ],
    },
  });
  try {
    const metrics = tools.get("squad_metrics");
    expect((await metrics.execute({}, { agent: "build" })).content).toContain("pass `models`");
    const summary = (
      await metrics.execute(
        {
          models: [
            "zai-coding-plan/glm-5.3",
            "anthropic/claude-sonnet-5-5",
            "opencode/big-pickle",
            "zai-coding-plan/glm-5.3",
          ],
        },
        { agent: "build" },
      )
    ).content;
    expect(summary).toContain("Model metrics for 3 model(s).");
    expect(summary).toMatch(
      /- zai-coding-plan\/glm-5\.3 \[grunt\]: SI 80\.6 #19 · ctx 1M · subscription: GLM Coding Pro/,
    );
    expect(summary).toContain("- anthropic/claude-sonnet-5-5: SI 85.2 #7");
    expect(summary).toContain("- no benchmark data: opencode/big-pickle");

    const one = (
      await tools
        .get("squad_metrics")
        .execute({ models: ["zai-coding-plan/glm-5.3"], full: true }, { agent: "build" })
    ).content;
    expect(fetched).toEqual(["https://api.llmbenchmark.ai/v1/models/z-ai%2Fglm-5.3"]);
    expect(one).toContain("## zai-coding-plan/glm-5.3");
    expect(one).toContain("cursorbench (max): cursorbench_4_0_score=0.426");
    // The full view knows the plan the summary shows (#53).
    expect(one).toMatch(/Serving: ctx 1M · subscription: GLM Coding Pro/);
  } finally {
    dispose();
    vi.unstubAllGlobals();
  }
});

test("squad_metrics full view fetches the same llmbenchmark id the summary attributes (#54)", async () => {
  const { indexModelIds, indexScoreRows, LLMBENCH_FORMAT } = await import("../src/metrics.js");
  const TB = "tbench_4_0_accuracy";
  const APEX = "epoch_apex_agents";
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "squad-host-"));
  dirs.push(directory);
  // The APEX-Agents slice comes first and holds only another model's id.
  globalThis.__squadMetricsData = {
    scores: {
      fetchedAtByMetric: { [APEX]: Date.now(), [TB]: Date.now() },
      formatByMetric: { [APEX]: LLMBENCH_FORMAT, [TB]: LLMBENCH_FORMAT },
      byMetric: {
        [APEX]: indexScoreRows([{ modelId: "other/m", value: 0.2 }]),
        [TB]: indexScoreRows([{ modelId: "p/m", value: 0.7 }]),
      },
    },
    ids: {
      fetchedAt: Date.now(),
      format: LLMBENCH_FORMAT,
      index: indexModelIds([{ id: "other/m" }]),
    },
  };
  const fetched = [];
  vi.stubGlobal("fetch", async (url) => {
    fetched.push(String(url));
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: "p/m", scores: [] }) };
  });
  const { tools, dispose } = await setupHost({ directory, agent: { list: async () => [] } });
  try {
    const metrics = tools.get("squad_metrics");
    const summary = (await metrics.execute({ models: ["p/m"] }, { agent: "build" })).content;
    expect(summary).toContain("TerminalBench4 0.7");
    expect(summary).not.toContain("APEX-Agents 0.2");
    await metrics.execute({ models: ["p/m"], full: true }, { agent: "build" });
    expect(fetched).toEqual(["https://api.llmbenchmark.ai/v1/models/p%2Fm"]);
  } finally {
    dispose();
    vi.unstubAllGlobals();
    delete globalThis.__squadMetricsData;
  }
});

test("squad_session reports a child's cache verdict and the caller's own clock", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "squad-host-"));
  dirs.push(directory);
  const lastHit = Date.now() - 60_000;
  const sessions = {
    ses_child: [
      { type: "user", time: { created: lastHit } },
      {
        type: "assistant",
        agent: "grunt-anthropic-claude-sonnet-5-5",
        model: { providerID: "anthropic", id: "claude-sonnet-5-5" },
        time: { created: lastHit, completed: lastHit + 1000 },
        finish: "stop",
        tokens: { input: 1, output: 10, reasoning: 0, cache: { read: 40_000, write: 0 } },
        content: [{ type: "text", text: "ok" }],
      },
    ],
  };
  const { tools, dispose } = await setupHost({
    directory,
    session: {
      hook: async () => {},
      context: async ({ sessionID }) => {
        // The host rejects an unknown id with an error object that has no message.
        if (sessionID === "ses_bogus") throw { _tag: "NotFoundError" };
        return { data: sessions[sessionID] ?? [] };
      },
    },
  });
  try {
    const session = tools.get("squad_session");
    const both = (
      await session.execute({ sessionIDs: ["ses_child", "ses_gone"] }, { agent: "build" })
    ).content;
    expect(both).toMatch(/^now: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    expect(both).toMatch(/cache: WARM — expires in 2[34]\d s/);
    expect(both).toContain("context: ~40k");
    expect(both).toContain("session ses_gone\nNo provider request found");
    expect(both.match(/^now: /gm)).toHaveLength(1);
    const bogus = (await session.execute({ sessionIDs: ["ses_bogus"] }, { agent: "build" }))
      .content;
    expect(bogus).toContain(
      "session ses_bogus: could not be read (NotFoundError). Treat it as cold.",
    );
    // One bare id instead of an array still works.
    const one = (await session.execute({ sessionIDs: "ses_child" }, { agent: "build" })).content;
    expect(one).toContain("session ses_child (grunt-anthropic-claude-sonnet-5-5");
    const own = (await session.execute({}, { agent: "build", sessionID: "ses_none" })).content;
    expect(own).toMatch(/^now: /);
    expect(own).not.toContain("your context");
  } finally {
    dispose();
  }
});

test("squad_patch validates its input with the same schema it advertises", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "squad-host-"));
  dirs.push(directory);
  const { tools, dispose } = await setupHost({ directory });
  const patch = tools.get("squad_patch");
  const run = async (input) => (await patch.execute(input, { agent: "build" })).content;
  const stored = () => readStore(defaultStoreFile()).state;
  try {
    // Advertised: the plain JSON Schema subset, no Zod-only keywords.
    const advertised = JSON.stringify(patch.input);
    for (const keyword of ["$schema", "propertyNames", "pattern", "9007199254740991"]) {
      expect(advertised).not.toContain(keyword);
    }
    expect(patch.input.properties.grunts.additionalProperties.additionalProperties).toBe(false);

    // Invalid fields and keys — even with allow_remove — write nothing.
    for (const allow_remove of [false, true]) {
      const bad = await run({
        allow_remove,
        grunts: { "a/b": { variant: "  ", steps: 0, colour: "red" }, nope: {} },
      });
      expect(bad).toContain("Roster is invalid");
      expect(bad).toContain('grunts["a/b"].variant must be a non-empty string when present');
      expect(bad).toContain('grunts["a/b"].steps must be a positive integer when present');
      expect(bad).toContain('grunts["a/b"] has unknown key "colour"');
      expect(bad).toContain('grunts["nope"]: "nope" is not a provider/model id');
      expect(stored()).toBe("missing");
    }
    // The call's own switches go through the same schema.
    const switches = await run({ allow_remove: "true", grunts: { "a/b": {} } });
    expect(switches).toContain("allow_remove must be a boolean when present");
    expect(stored()).toBe("missing");

    // Wrapped or missing roster: refused before validation, nothing written.
    expect(await run({ roster: { grunts: { "a/b": {} } } })).toContain("Refused: pass `grunts`");
    expect(await run({})).toContain("Refused: pass `grunts`");
    expect(stored()).toBe("missing");

    // A valid one-role roster is written.
    expect(await run({ grunts: { "a/b": { variant: "high" } } })).toContain("+1 added");
    expect(readStore(defaultStoreFile())).toEqual({
      state: "ok",
      roster: { grunts: { "a/b": { variant: "high" } }, drills: {} },
    });
    expect(fs.readdirSync(directory)).toEqual([]);
  } finally {
    dispose();
  }
});
