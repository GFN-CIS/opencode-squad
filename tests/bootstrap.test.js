import { test, expect } from "bun:test";
import { buildBootstrap, BOOTSTRAP_MARKER } from "../src/bootstrap.js";

test("block starts with the marker and embeds inventory", () => {
  const inv = "- `worker`: Generic executor (model: anthropic/claude-sonnet-4-6)";
  const out = buildBootstrap(inv);
  expect(out.startsWith(BOOTSTRAP_MARKER)).toBe(true);
  expect(out).toContain(inv);
});

test("mentions the delegation decision and points to the protocol skill", () => {
  const out = buildBootstrap("(no subagents available)");
  expect(out.toLowerCase()).toContain("delegate");
  expect(out).toContain("sarge-delegate"); // detailed protocol lives there
});

test("keeps the decision principles inline (capability + risk one-liners)", () => {
  // Principles stay in the lean injection; the detailed gate/ladder moved to
  // the sarge-delegate skill.
  const out = buildBootstrap("(no subagents available)").toLowerCase();
  expect(out).toContain("capability");
  expect(out).toContain("production write"); // never hand it to the cheap worker
});

test("keeps the stall trigger inline and points to the sarge-stall skill", () => {
  const out = buildBootstrap("(no subagents available)").toLowerCase();
  expect(out).toContain("stall");
  expect(out).toContain("different"); // re-decide -> different model
  expect(out).toContain("sarge-stall"); // full ladder is a separate skill
});

test("tells the orchestrator not to reload a skill already in context", () => {
  // collapse whitespace so a line wrap inside the phrase doesn't matter
  const out = buildBootstrap("(no subagents available)")
    .toLowerCase()
    .replace(/\s+/g, " ");
  expect(out).toContain("already in your context");
  expect(out).toContain("don't reload it every turn");
});

test("embeds live session facts (time + current model) when provided", () => {
  const out = buildBootstrap("(no subagents available)", {
    nowText: "2026-06-19 11:49:52 (Europe/Moscow)",
    modelText: "anthropic/claude-opus-4-7",
  });
  expect(out.startsWith(BOOTSTRAP_MARKER)).toBe(true);
  expect(out).toContain("2026-06-19 11:49:52 (Europe/Moscow)");
  expect(out).toContain("anthropic/claude-opus-4-7");
  expect(out.toLowerCase()).toContain("trust this over any assumption");
});

test("omits the facts block when no facts are provided", () => {
  const out = buildBootstrap("(no subagents available)");
  expect(out.startsWith(BOOTSTRAP_MARKER)).toBe(true);
  expect(out).not.toContain("Current local time");
  expect(out).not.toContain("You are running on");
});

test("marker is the exact stable string the injection guard relies on", () => {
  // Pinned: the plugin's double-injection guard does
  // `text.includes(BOOTSTRAP_MARKER)`. Changing this value silently breaks
  // that guard, so the exact string is part of the contract.
  expect(BOOTSTRAP_MARKER).toBe("<ORCHESTRATE_BOOTSTRAP>");
});
