import { test, expect } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentDefinitions } from "../src/agents.js";

const promptsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "prompts",
);

test("defines worker and work-reviewer subagents", () => {
  const defs = agentDefinitions(promptsDir);
  expect(Object.keys(defs).sort()).toEqual(["work-reviewer", "worker"]);
});

test("worker can edit and run bash but cannot spawn tasks", () => {
  const { worker } = agentDefinitions(promptsDir);
  expect(worker.mode).toBe("subagent");
  expect(worker.hidden).toBe(true);
  expect(worker.model).toBe("anthropic/claude-sonnet-4-6");
  expect(worker.permission.edit).toBe("allow");
  expect(worker.permission.bash).toBe("allow");
  expect(worker.permission.task["*"]).toBe("deny");
  expect(worker.prompt.length).toBeGreaterThan(20);
});

test("reviewer is read-only and cannot spawn tasks", () => {
  const reviewer = agentDefinitions(promptsDir)["work-reviewer"];
  expect(reviewer.permission.edit).toBe("deny");
  expect(reviewer.permission.bash).toBe("deny");
  expect(reviewer.permission.task["*"]).toBe("deny");
  expect(reviewer.prompt).toContain("STRICT JSON");
});
