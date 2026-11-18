// Suite: the package entry (index.js → .opencode/lib/orchestrate-v2.js) as an
// OpenCode 2 host sees it. Covers setup registering the squad_* tools,
// squad_patch generating native V2 agent files, and squad_metrics rendering
// host models + cached metrics, with the startup network refreshes stubbed at
// the runtime boundary. Not covered: live hook firing,
// rate-limit guard and skill loading — those need a real host or their own
// suites. Run: npx vitest run tests/plugin-entry.test.js

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import plugin from "../index.js";

// Startup refreshes write global model data and schedule network requests;
// leave tool registration and the filesystem generator real.
vi.mock("../.opencode/lib/runtime.js", async (importOriginal) => {
  const { indexScoreRows, indexSuperIndex } = await import("../src/metrics.js");
  const fx = (name) =>
    JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, "fixtures", "metrics", name), "utf8"),
    );
  const rows = fx("llmbench-scores.json");
  const data = {
    superindex: { fetchedAt: Date.now(), index: indexSuperIndex(fx("superindex.json")) },
    scores: {
      fetchedAt: Date.now(),
      byMetric: Object.fromEntries(Object.entries(rows).map(([m, r]) => [m, indexScoreRows(r)])),
    },
    ids: { fetchedAt: Date.now(), index: { "glm-5-3": "z-ai/glm-5.3" } },
  };
  return {
    ...(await importOriginal()),
    ensureGlobalModelDataFresh: () => {},
    // Both would touch the REAL global agent dir / model_data.json.
    syncGlobalSquadDescriptions: () => [],
    squadDescriber: () => (role, id) => `${role} on ${id}. Owner rule: no secrets.`,
    startMetricsRefresh: () => {},
    getMetrics: async () => data,
    loadModelData: () => null,
    loadProviderPlans: () => ({ "zai-coding-plan": "GLM Coding Pro" }),
    loadAuthTypes: () => ({}),
    METRICS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "squad-host-metrics-")),
  };
});

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test("package exposes only setup and squad_patch generates native agents", async () => {
  expect(plugin.server).toBeUndefined();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "squad-host-"));
  dirs.push(directory);
  const input = {
    directory,
    grunts: { "a/b": { variant: "high" } },
    drills: { "a/b": { variant: "high" } },
  };
  const tools = new Map();
  const dispose = await plugin.setup({
    location: { directory },
    options: { rate_limit_guard: { enabled: false } },
    skill: { transform: async () => {} },
    session: { hook: async () => {} },
    model: { list: async () => [] },
    tool: {
      hook: async () => {},
      transform: async (register) => register({ add: (tool) => tools.set(tool.name, tool) }),
    },
  });
  let wrapped;
  try {
    const patch = tools.get("squad_patch");
    // A roster wrapped one level too deep must not read as "delete everything".
    wrapped = (await patch.execute({ roster: input, directory }, { agent: "build" })).content;
    await patch.execute(input, { agent: "build" });
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
  for (const role of ["grunt", "drill"]) {
    const content = fs.readFileSync(path.join(directory, `${role}-a-b.md`), "utf8");
    expect(content).toContain(`description: "${role} on a/b. Owner rule: no secrets."\n`);
    expect(content).toContain("permissions:\n");
    expect(content).toContain("model: a/b#high\n");
    expect(content).not.toContain("permission:");
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
  const tools = new Map();
  const dispose = await plugin.setup({
    location: { directory },
    options: { rate_limit_guard: { enabled: false } },
    skill: { transform: async () => {} },
    session: { hook: async () => {} },
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
    tool: {
      hook: async () => {},
      transform: async (register) => register({ add: (tool) => tools.set(tool.name, tool) }),
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
  } finally {
    dispose();
    vi.unstubAllGlobals();
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
  const tools = new Map();
  const dispose = await plugin.setup({
    location: { directory },
    options: { rate_limit_guard: { enabled: false } },
    skill: { transform: async () => {} },
    session: {
      hook: async () => {},
      context: async ({ sessionID }) => {
        // The host rejects an unknown id with an error object that has no message.
        if (sessionID === "ses_bogus") throw { _tag: "NotFoundError" };
        return { data: sessions[sessionID] ?? [] };
      },
    },
    model: { list: async () => [] },
    tool: {
      hook: async () => {},
      transform: async (register) => register({ add: (tool) => tools.set(tool.name, tool) }),
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
