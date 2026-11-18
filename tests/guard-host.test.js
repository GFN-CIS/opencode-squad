// Suite: the rate-limit guard and model catalog as wired in
// .opencode/lib/orchestrate-v2.js, driven through plugin.setup with a simulated
// OpenCode 2 host: an event stream, session.interrupt / synthetic, and
// model.list. Timers are faked; the silence poll runs every 15 s. Startup
// file writers, metric refreshes and model_data reads are stubbed at the
// runtime boundary.
// Run: npx vitest run tests/guard-host.test.js

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadModelSettings } from "../.opencode/lib/runtime.js";
import plugin from "../index.js";

vi.mock("../.opencode/lib/runtime.js", async (importOriginal) => ({
  ...(await importOriginal()),
  ensureGlobalModelDataFresh: () => {},
  syncGlobalSquadDescriptions: () => [],
  squadDescriber: () => (role, id) => `${role} on ${id}.`,
  startMetricsRefresh: () => {},
  getMetrics: async () => null,
  loadModelSettings: vi.fn(() => ({ models: {}, providers: {}, found: false, problems: [] })),
  loadAuthTypes: () => ({}),
}));

const SILENCE_S = 60;
const POLL_MS = 15_000;

/** A host event stream the test pushes into. */
function eventStream() {
  const queue = [];
  let wake;
  return {
    push(type, data) {
      queue.push({ type, data });
      wake?.();
    },
    async *subscribe({ signal }) {
      while (!signal.aborted) {
        if (queue.length) {
          yield queue.shift();
          continue;
        }
        await new Promise((resolve) => {
          wake = resolve;
          signal.addEventListener("abort", resolve, { once: true });
        });
        wake = undefined;
      }
    },
  };
}

/** @param {{interrupt?: () => Promise<unknown>, modelList?: () => Promise<unknown>}} [over] */
async function host(over = {}) {
  const events = eventStream();
  const notes = [];
  const interrupts = [];
  const tools = new Map();
  const dispose = await plugin.setup({
    location: { directory: os.tmpdir() },
    options: { rate_limit_guard: { max_silence_seconds: SILENCE_S } },
    skill: { transform: async () => {} },
    agent: { list: async () => [] },
    model: { list: over.modelList ?? (async () => []) },
    session: {
      hook: async () => {},
      get: async ({ sessionID }) =>
        sessionID === "child" ? { id: "child", parentID: "parent", agent: "grunt-a-b" } : {},
      interrupt: async (input) => {
        interrupts.push(input);
        return over.interrupt ? over.interrupt() : { interrupted: true };
      },
      synthetic: async (input) => {
        notes.push(input);
      },
    },
    event: { subscribe: (opts) => events.subscribe(opts) },
    tool: {
      hook: async () => {},
      transform: async (register) => register({ add: (tool) => tools.set(tool.name, tool) }),
    },
  });
  return { events, notes, interrupts, tools, dispose };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const silence = () => vi.advanceTimersByTimeAsync(SILENCE_S * 1000 + 2 * POLL_MS);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test("a silent child that the host confirms interrupted gets a note that says so", async () => {
  const h = await host();
  try {
    h.events.push("session.created", {
      sessionID: "child",
      parentID: "parent",
      agent: "grunt-a-b",
    });
    await flush();
    await silence();
    expect(h.interrupts).toEqual([{ sessionID: "child", resume: false }]);
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0].sessionID).toBe("parent");
    expect(h.notes[0].text).toContain("was interrupted");
    expect(h.notes[0].text).toContain("may already have changed files");
    expect(h.notes[0].text).not.toContain("never got a chance to run");
  } finally {
    h.dispose();
  }
});

test("a rejected interrupt is reported as unconfirmed: the child may still be running", async () => {
  const h = await host({ interrupt: async () => Promise.reject(new Error("boom")) });
  try {
    h.events.push("session.created", { sessionID: "child", parentID: "parent" });
    await flush();
    await silence();
    expect(h.interrupts).toHaveLength(1);
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0].text).toContain("could NOT confirm the interrupt");
    expect(h.notes[0].text).toContain("may STILL be running");
    expect(h.notes[0].text).not.toContain("was interrupted");
  } finally {
    h.dispose();
  }
});

test("an interrupt that finds nothing running says the child may have finished", async () => {
  const h = await host({ interrupt: async () => ({ interrupted: false }) });
  try {
    h.events.push("session.created", { sessionID: "child", parentID: "parent" });
    await flush();
    await silence();
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0].text).toContain("no longer running");
  } finally {
    h.dispose();
  }
});

test("a resumed child gets a fresh silence window; an idle one is left alone", async () => {
  const h = await host();
  try {
    // First execution: guarded once by silence.
    h.events.push("session.created", { sessionID: "child", parentID: "parent" });
    h.events.push("session.execution.started", { sessionID: "child" });
    await flush();
    await silence();
    expect(h.interrupts).toHaveLength(1);
    h.events.push("session.execution.interrupted", { sessionID: "child" });
    await flush();

    // Idle between executions: no watcher, no interrupt however long it waits.
    await vi.advanceTimersByTimeAsync(10 * SILENCE_S * 1000);
    expect(h.interrupts).toHaveLength(1);

    // Resumed by session id: no session.created, just a new execution. The
    // previous `guarded` state must not stop the new watcher.
    h.events.push("session.execution.started", { sessionID: "child" });
    await flush();
    await silence();
    expect(h.interrupts).toHaveLength(2);
    expect(h.notes).toHaveLength(2);

    // Once per execution, not once per tick.
    await vi.advanceTimersByTimeAsync(5 * SILENCE_S * 1000);
    expect(h.interrupts).toHaveLength(2);
  } finally {
    h.dispose();
  }
});

test("a resumed child that keeps producing events is not interrupted", async () => {
  const h = await host();
  try {
    h.events.push("session.execution.started", { sessionID: "child" });
    await flush();
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(POLL_MS);
      h.events.push("session.text.delta", { sessionID: "child" });
      await flush();
    }
    h.events.push("session.execution.succeeded", { sessionID: "child" });
    await flush();
    await silence();
    expect(h.interrupts).toHaveLength(0);
  } finally {
    h.dispose();
  }
});

test("a failed model catalog lookup is retried by the next call", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "squad-catalog-"));
  let calls = 0;
  const h = await host({
    modelList: async () => {
      calls++;
      if (calls === 1) throw new Error("host not ready");
      return [{ providerID: "a", id: "b", variants: [{ id: "high" }] }];
    },
  });
  try {
    const dump = h.tools.get("squad_dump");
    const patch = h.tools.get("squad_patch");
    // The first lookup fails: variants read as unknown, not as "none".
    expect((await dump.execute({ directory })).content).toContain("could not be read");
    // The next one asks again and checks the variant against the catalog.
    const res = await patch.execute(
      { directory, grunts: { "a/b": { variant: "ultra" } } },
      { agent: "build" },
    );
    expect(res.content).toContain("Roster is invalid");
    expect(res.content).toContain('variant "ultra" is not accepted');
    expect(fs.readdirSync(directory)).toEqual([]);
    expect(calls).toBe(2);
    // A successful catalog is kept.
    await dump.execute({ directory });
    expect(calls).toBe(2);
  } finally {
    h.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("squad_patch refuses while model_data.json is unreadable, writing nothing", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "squad-unreadable-"));
  const h = await host();
  vi.mocked(loadModelSettings).mockReturnValueOnce({
    models: {},
    providers: {},
    found: false,
    problems: ["/cfg/opencode/model_data.json: invalid JSON at line 3, column 1"],
  });
  try {
    const res = await h.tools
      .get("squad_patch")
      .execute({ directory, grunts: { "a/b": {} } }, { agent: "build" });
    expect(res.content).toContain("Refused: model_data.json cannot be read");
    expect(res.content).toContain("invalid JSON at line 3, column 1");
    expect(fs.readdirSync(directory)).toEqual([]);
  } finally {
    h.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
