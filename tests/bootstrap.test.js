import { test, expect } from "bun:test";
import { buildBootstrap, BOOTSTRAP_MARKER } from "../src/bootstrap.js";

test("block starts with the marker and embeds inventory", () => {
  const inv = "- `worker`: Generic executor (model: anthropic/claude-sonnet-4-6)";
  const out = buildBootstrap(inv);
  expect(out.startsWith(BOOTSTRAP_MARKER)).toBe(true);
  expect(out).toContain(inv);
});

test("mentions the delegation decision and the skill name", () => {
  const out = buildBootstrap("(no subagents available)");
  expect(out.toLowerCase()).toContain("delegate");
  expect(out).toContain("orchestrating-subagents");
});

test("carries the capability and high-risk matching rules", () => {
  const out = buildBootstrap("(no subagents available)").toLowerCase();
  // Capability: don't hand high-cognition work to the cheap worker.
  expect(out).toContain("capability");
  expect(out).toContain("strong model");
  // Risk: prod-write/destructive needs confirmation before apply.
  expect(out).toContain("risk");
  expect(out).toContain("confirmation");
});

test("marker is the exact stable string the injection guard relies on", () => {
  // Pinned: the plugin's double-injection guard does
  // `text.includes(BOOTSTRAP_MARKER)`. Changing this value silently breaks
  // that guard, so the exact string is part of the contract.
  expect(BOOTSTRAP_MARKER).toBe("<ORCHESTRATE_BOOTSTRAP>");
});
