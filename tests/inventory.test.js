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

test("appends the minimal AA bench summary when a snapshot is given", () => {
  const models = {
    "gpt-5-5": {
      intelligence: 54.8,
      coding: 74.9,
      agentic: { tau2: 0.9, terminalbench_v2_1: 0.8 },
      price_blended: 11.25,
    },
  };
  const agents = [
    {
      name: "grunt-openai-gpt-5-5",
      mode: "subagent",
      description: "Per-model grunt.",
      model: { providerID: "openai", modelID: "gpt-5.5" },
    },
  ];
  const out = formatInventory(agents, models);
  expect(out).toContain("AA intel 55 · code 75 · agentic 85 · $11.25/M");
  // without a snapshot, no bench tail
  expect(formatInventory(agents)).not.toContain("AA intel");
});

test("uses a perf lookup function when given one (model_data path)", () => {
  const agents = [
    {
      name: "grunt-openai-gpt-5-5",
      mode: "subagent",
      description: "Per-model grunt.",
      model: { providerID: "openai", modelID: "gpt-5.5" },
    },
  ];
  const lookup = (id) => (id === "openai/gpt-5.5" ? "AA intel 55 · note: good for coding" : null);
  const out = formatInventory(agents, lookup);
  expect(out).toContain("— AA intel 55 · note: good for coding");
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
  const out = formatInventory(agents, null, limits);
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
