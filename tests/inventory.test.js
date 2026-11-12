import { expect, test } from "vitest";
import { formatInventory, hasSquad } from "../src/inventory.js";

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
  expect(formatInventory([{ name: "build", mode: "primary", builtIn: true }])).toBe(
    "(no subagents available)",
  );
});

test("handles missing description", () => {
  const out = formatInventory([{ name: "x", mode: "subagent", builtIn: false }]);
  expect(out).toContain("- `x`: (no description) (model: inherited)");
});

test("never carries benchmarks or prices — those come from squad_metrics", () => {
  const agents = [
    {
      name: "grunt-openai-gpt-5-5",
      mode: "subagent",
      description: "Per-model grunt.",
      model: { providerID: "openai", modelID: "gpt-5.5" },
    },
  ];
  expect(formatInventory(agents, { "openai/gpt-5.5": 400000 })).toBe(
    "- `grunt-openai-gpt-5-5`: Per-model grunt. (model: openai/gpt-5.5 · ctx 400k)",
  );
});

test("adds the context window from the limits map", () => {
  const agents = [
    {
      name: "g1",
      mode: "subagent",
      description: "x",
      model: { providerID: "openai", modelID: "gpt-5.5" },
    },
    {
      name: "g2",
      mode: "subagent",
      description: "x",
      model: { providerID: "anthropic", modelID: "claude-opus-4-8" },
    },
  ];
  const limits = { "openai/gpt-5.5": 400000, "anthropic/claude-opus-4-8": 1000000 };
  const out = formatInventory(agents, limits);
  expect(out).toContain("ctx 400k");
  expect(out).toContain("ctx 1M");
});

test("hasSquad is true when a grunt-* or drill-* agent is present", () => {
  expect(hasSquad([{ name: "grunt-anthropic-claude-sonnet-5" }])).toBe(true);
  expect(hasSquad([{ name: "drill-openai-gpt-5-5" }])).toBe(true);
});

test("hasSquad is false with no squad, no agents, or a name that merely contains grunt/drill", () => {
  expect(hasSquad([{ name: "explore" }, { name: "build" }])).toBe(false);
  expect(hasSquad([])).toBe(false);
  expect(hasSquad(undefined)).toBe(false);
  // must be a prefix match, not "contains" (e.g. a hand-authored "my-grunt-helper")
  expect(hasSquad([{ name: "my-grunt-helper" }])).toBe(false);
});
