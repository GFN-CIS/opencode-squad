import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import v2 from "../.opencode/lib/orchestrate-v2.js";
import { OrchestratePlugin } from "../.opencode/plugins/orchestrate.js";

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

test.each([1, 2])("OpenCode %s selects its drill format", async (generation) => {
  const directory = fs.mkdtempSync("/tmp/opencode/squad-host-");
  dirs.push(directory);
  const input = { directory, drills: { "a/b": { variant: "high" } } };
  if (generation === 1) {
    const plugin = await OrchestratePlugin(
      {
        directory,
        client: { config: { providers: async () => ({ data: { providers: [] } }) } },
      },
      { rate_limit_guard: { enabled: false } },
    );
    await plugin.tool.squad_patch.execute(input, { agent: "build" });
  } else {
    const tools = new Map();
    const dispose = await v2.setup({
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
  }
  const content = fs.readFileSync(path.join(directory, "drill-a-b.md"), "utf8");
  if (generation === 1) {
    expect(content).toContain("permission:\n  edit: deny\n  bash: deny\n");
    expect(content).toContain("model: a/b\nvariant: high\n");
    expect(content).not.toContain("permissions:");
  } else {
    expect(content).toContain('permissions:\n  - {"action":"*","resource":"*","effect":"deny"}');
    expect(content).toContain("model: a/b#high\n");
    expect(content).not.toContain("permission:");
  }
});
