import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import plugin from "../index.js";

// Startup refreshes write global model data and schedule network requests;
// leave tool registration and the filesystem generator real.
vi.mock("../.opencode/lib/runtime.js", async (importOriginal) => ({
  ...(await importOriginal()),
  ensureGlobalModelDataFresh: () => {},
  startBenchmarkRefresh: () => {},
}));

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
  try {
    await tools.get("squad_patch").execute(input, { agent: "build" });
  } finally {
    dispose();
  }
  for (const role of ["grunt", "drill"]) {
    const content = fs.readFileSync(path.join(directory, `${role}-a-b.md`), "utf8");
    expect(content).toContain("permissions:\n");
    expect(content).toContain("model: a/b#high\n");
    expect(content).not.toContain("permission:");
  }
});
