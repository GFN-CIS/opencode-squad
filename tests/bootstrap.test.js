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

test("marker is a stable non-empty string", () => {
  expect(typeof BOOTSTRAP_MARKER).toBe("string");
  expect(BOOTSTRAP_MARKER.length).toBeGreaterThan(0);
});
