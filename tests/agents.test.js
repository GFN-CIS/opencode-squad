import { test, expect } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentDefinitions } from "../src/agents.js";

const promptsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "prompts",
);

test("defines grunt and drill subagents", () => {
  const defs = agentDefinitions(promptsDir);
  expect(Object.keys(defs).sort()).toEqual(["drill", "grunt"]);
});

test("grunt can edit and run bash but cannot spawn tasks", () => {
  const { grunt } = agentDefinitions(promptsDir);
  expect(grunt.mode).toBe("subagent");
  expect(grunt.hidden).toBe(true);
  expect(grunt.model).toBe("anthropic/claude-sonnet-4-6");
  expect(grunt.permission.edit).toBe("allow");
  expect(grunt.permission.bash).toBe("allow");
  expect(grunt.permission.task["*"]).toBe("deny");
  expect(grunt.prompt.length).toBeGreaterThan(20);
});

test("drill is read-only and cannot spawn tasks", () => {
  const { drill } = agentDefinitions(promptsDir);
  expect(drill.mode).toBe("subagent");
  expect(drill.hidden).toBe(true);
  expect(drill.model).toBe("anthropic/claude-sonnet-4-6");
  expect(drill.permission.edit).toBe("deny");
  expect(drill.permission.bash).toBe("deny");
  // webfetch is the one capability drill needs to read external refs;
  // assert it so an accidental removal is caught.
  expect(drill.permission.webfetch).toBe("allow");
  expect(drill.permission.task["*"]).toBe("deny");
  expect(drill.prompt).toContain("STRICT JSON");
});
