import { expect, test } from "vitest";
import { BOOTSTRAP_MARKER, buildBootstrap } from "../src/bootstrap.js";

test("block starts with the marker and embeds inventory", () => {
  const inv = "- `worker`: Generic executor (model: anthropic/claude-sonnet-4-6)";
  const out = buildBootstrap(inv);
  expect(out.startsWith(BOOTSTRAP_MARKER)).toBe(true);
  expect(out).toContain(inv);
});

test("mentions the delegation decision and points to the protocol skill", () => {
  const out = buildBootstrap("(no subagents available)");
  expect(out).toContain("squad-delegate"); // detailed protocol lives there
});

test("keeps the decision principles inline (capability + risk one-liners)", () => {
  // Principles stay in the lean injection; the detailed gate/ladder moved to
  // the squad-delegate skill.
  const out = buildBootstrap("(no subagents available)").toLowerCase().replace(/\s+/g, " ");
  expect(out).toContain("route by capability");
  expect(out).toContain("production write"); // never hand it to the cheap worker
});

test("tells a weak orchestrator to escalate capability UP", () => {
  // The guidance, not the slogan: when the task is beyond the orchestrator's own
  // model, hand it (or the pivotal call) to a stronger grunt, or consult one.
  const out = buildBootstrap("(no subagents available)").toLowerCase().replace(/\s+/g, " ");
  expect(out).toContain("beyond your own model's depth");
  expect(out).toContain("delegate it up to the strongest fit grunt");
  expect(out).toContain("second opinion before you commit");
});

test("forbids `general` unless explicitly asked (it inherits the primary model)", () => {
  const out = buildBootstrap("(no subagents available)");
  expect(out).toContain("`general`");
  expect(out.toLowerCase()).toContain("unless the user explicitly");
  expect(out).toContain("`explore`"); // steer read-only to explore instead
});

test("keeps the stall trigger inline and points to the squad-stall skill", () => {
  const out = buildBootstrap("(no subagents available)").toLowerCase().replace(/\s+/g, " ");
  expect(out).toMatch(/delegate to a \*?different\*? model/); // re-decide, not retry
  expect(out).toContain("squad-stall"); // full ladder is a separate skill
});

test("warns that context pressure alone is no reason to delegate (compaction exists)", () => {
  const out = buildBootstrap("(no subagents available)").toLowerCase().replace(/\s+/g, " ");
  expect(out).toContain("opencode compacts automatically");
  expect(out).toContain("delegating a *minor* task just because the percentage looks high");
});

test("mentions caching cost and subscription-vs-api billing, pointing to squad-delegate", () => {
  const out = buildBootstrap("(no subagents available)").toLowerCase();
  expect(out).toContain("cache hit");
  expect(out).toContain("subscription");
  expect(out).toContain("squad-delegate");
});

test("tells the orchestrator not to reload a skill already in context", () => {
  // collapse whitespace so a line wrap inside the phrase doesn't matter
  const out = buildBootstrap("(no subagents available)").toLowerCase().replace(/\s+/g, " ");
  expect(out).toContain("already in your context");
  expect(out).toContain("don't reload it every turn");
});

test("embeds the current model when provided, and no clock", () => {
  const out = buildBootstrap("(no subagents available)", {
    modelText: "anthropic/claude-opus-4-7",
  });
  expect(out.startsWith(BOOTSTRAP_MARKER)).toBe(true);
  // A clock here changes every turn; squad_session returns the time instead.
  expect(out).not.toMatch(/local time/i);
  expect(out).toContain("anthropic/claude-opus-4-7");
});

test("tells the orchestrator to send the user to squad-draft when no squad is drafted", () => {
  const out = buildBootstrap("(no subagents available)", { hasSquad: false });
  expect(out).toContain("squad-draft");
  expect(out.toLowerCase()).toContain("no squad drafted yet");
  expect(out.toLowerCase()).toContain("don't invent");
});

test("omits the no-squad warning once a squad exists", () => {
  const inv = "- `grunt-anthropic-claude-sonnet-5`: worker (model: anthropic/claude-sonnet-5)";
  const out = buildBootstrap(inv, { hasSquad: true });
  expect(out.toLowerCase()).not.toContain("no squad drafted");
});

test("omits the no-squad warning when hasSquad is not passed (back-compat)", () => {
  const out = buildBootstrap("(no subagents available)");
  expect(out.toLowerCase()).not.toContain("no squad drafted");
});
