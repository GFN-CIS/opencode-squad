import { test, expect } from "bun:test";
import { formatInventory } from "../src/inventory.js";

test("lists only subagents with name, description, model", () => {
  const agents = [
    { name: "build", mode: "primary", builtIn: true },
    {
      name: "worker",
      mode: "subagent",
      builtIn: false,
      description: "Generic executor",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    },
    {
      name: "explore",
      mode: "subagent",
      builtIn: true,
      description: "Read-only explorer",
    },
  ];
  const out = formatInventory(agents);
  expect(out).toContain("- `worker`: Generic executor (model: anthropic/claude-sonnet-4-6)");
  expect(out).toContain("- `explore`: Read-only explorer (model: inherited)");
  expect(out).not.toContain("build");
});

test("returns placeholder when no subagents", () => {
  expect(formatInventory([{ name: "build", mode: "primary", builtIn: true }]))
    .toBe("(no subagents available)");
});

test("handles missing description", () => {
  const out = formatInventory([
    { name: "x", mode: "subagent", builtIn: false },
  ]);
  expect(out).toContain("- `x`: (no description) (model: inherited)");
});
