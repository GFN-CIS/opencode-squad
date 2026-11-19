// Suite: src/bootstrap.js — the block appended to the orchestrator's system
// prompt. Only its contracts are pinned: the marker that frames it (the
// duplicate-injection guard in src/v2/adapt.js reads it), the skill and agent
// names its guidance routes to (a rename there breaks discoverability), byte
// stability (the prompt cache depends on it) and the no-squad switch. Its
// prose is not: equivalent wording is not a regression (#76).
// Run: npx vitest run tests/bootstrap.test.js

import { afterEach, expect, test, vi } from "vitest";
import { BOOTSTRAP_MARKER, buildBootstrap } from "../src/bootstrap.js";

afterEach(() => {
  vi.useRealTimers();
});

const INV = "- `grunt-anthropic-claude-sonnet-5`: worker (model: anthropic/claude-sonnet-5)";

test("framed by the marker, with the inventory inside", () => {
  const out = buildBootstrap(INV);
  expect(out.startsWith(BOOTSTRAP_MARKER)).toBe(true);
  expect(out.trimEnd().endsWith(`</${BOOTSTRAP_MARKER.slice(1)}`)).toBe(true);
  expect(out).toContain(INV);
});

test("names every skill and agent its guidance routes to", () => {
  const out = buildBootstrap(INV, { hasSquad: true });
  // The skills it defers to, and the built-in agents it steers between.
  for (const name of ["squad-delegate", "squad-stall", "`general`", "`explore`"]) {
    expect(out, name).toContain(name);
  }
});

test("byte-stable across turns: same inputs, same block, whatever the clock", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const first = buildBootstrap(INV, { modelText: "anthropic/claude-opus-5", hasSquad: true });
  vi.setSystemTime(new Date("2026-07-01T13:37:00Z"));
  const later = buildBootstrap(INV, { modelText: "anthropic/claude-opus-5", hasSquad: true });
  expect(later).toBe(first);
  expect(first).toContain("anthropic/claude-opus-5");
});

test("points to squad-draft only while no squad is drafted", () => {
  expect(buildBootstrap(INV, { hasSquad: false })).toContain("squad-draft");
  expect(buildBootstrap(INV, { hasSquad: true })).not.toContain("squad-draft");
  // Not passed: treated as drafted, so no false alarm (back-compat).
  expect(buildBootstrap(INV)).toBe(buildBootstrap(INV, { hasSquad: true }));
});
