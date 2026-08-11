import { expect, test } from "vitest";
import { BOOTSTRAP_MARKER } from "../src/bootstrap.js";
import { CONTEXT_MARKER } from "../src/context.js";
import {
  applyOrchestratorTransform,
  findInjectionTarget,
  hasBootstrapMarker,
  isInternalGeneration,
} from "../src/message-transform.js";

const ORCH = "build";

function userMsg({ agent = ORCH, text = "hi" } = {}) {
  return { info: { role: "user", agent }, parts: [{ type: "text", text }] };
}
function assistantMsg({ agent = ORCH, modelID, providerID, tokens } = {}) {
  return { info: { role: "assistant", agent, modelID, providerID, tokens } };
}

test("isInternalGeneration matches opencode's own title/summary prompts, not real user text", () => {
  expect(isInternalGeneration("Generate a title for this conversation")).toBe(true);
  expect(isInternalGeneration("  Summarize what was done in this conversation please")).toBe(true);
  expect(isInternalGeneration("please summarize the deploy")).toBe(false);
});

test("findInjectionTarget returns null when no message is tagged with the orchestrator agent", () => {
  const messages = [userMsg({ agent: "grunt-anthropic-claude-opus-5" })];
  expect(findInjectionTarget(messages, ORCH)).toBe(null);
});

test("findInjectionTarget returns null when there's no user message with parts", () => {
  const messages = [assistantMsg({}), { info: { role: "user", agent: ORCH }, parts: [] }];
  expect(findInjectionTarget(messages, ORCH)).toBe(null);
});

test("findInjectionTarget skips opencode's own internal generation prompts", () => {
  const messages = [assistantMsg({}), userMsg({ text: "Generate a title for this conversation" })];
  expect(findInjectionTarget(messages, ORCH)).toBe(null);
});

test("findInjectionTarget picks the LATEST user message with parts (survives compaction)", () => {
  const first = userMsg({ text: "first turn" });
  const last = userMsg({ text: "latest turn" });
  const messages = [first, assistantMsg({}), last];
  expect(findInjectionTarget(messages, ORCH)).toBe(last);
});

test("hasBootstrapMarker detects an already-injected bootstrap part", () => {
  const withMarker = { parts: [{ type: "text", text: `${BOOTSTRAP_MARKER}...` }] };
  const without = { parts: [{ type: "text", text: "plain text" }] };
  expect(hasBootstrapMarker(withMarker)).toBe(true);
  expect(hasBootstrapMarker(without)).toBe(false);
});

test("applyOrchestratorTransform injects the bootstrap once, unshifted before the user's text", async () => {
  const target = userMsg({ text: "do the thing" });
  const messages = [target];
  let inventoryCalls = 0;
  await applyOrchestratorTransform(messages, {
    orchestratorAgent: ORCH,
    getInventory: async () => {
      inventoryCalls++;
      return "- `grunt`: Generic executor (model: anthropic/claude-sonnet-4-6)";
    },
    getLimitMap: async () => ({}),
    getHasSquad: () => true,
    orchestratorModel: "anthropic/claude-opus-4-7",
  });

  expect(inventoryCalls).toBe(1);
  expect(target.parts.length).toBe(2); // bootstrap unshifted + original text
  expect(target.parts[0].text).toContain(BOOTSTRAP_MARKER);
  expect(target.parts[0].text).toContain("grunt");
  expect(target.parts[1].text).toBe("do the thing");
});

test("applyOrchestratorTransform is idempotent within a call — skips re-injecting if the marker is already present", async () => {
  const target = {
    info: { role: "user", agent: ORCH },
    parts: [{ type: "text", text: `${BOOTSTRAP_MARKER} already here` }],
  };
  const messages = [target];
  let inventoryCalls = 0;
  await applyOrchestratorTransform(messages, {
    orchestratorAgent: ORCH,
    getInventory: async () => {
      inventoryCalls++;
      return "(no subagents available)";
    },
    getLimitMap: async () => ({}),
    getHasSquad: () => false,
    orchestratorModel: null,
  });
  expect(inventoryCalls).toBe(0);
  expect(target.parts.length).toBe(1);
});

test("applyOrchestratorTransform appends a context-budget line when usage is estimable, using the real model's limit", async () => {
  const target = userMsg({ text: "continue" });
  const messages = [
    assistantMsg({
      modelID: "claude-opus-4-7",
      providerID: "anthropic",
      tokens: { total: 500_000 },
    }),
    target,
  ];
  await applyOrchestratorTransform(messages, {
    orchestratorAgent: ORCH,
    getInventory: async () => "(no subagents available)",
    getLimitMap: async () => ({ "anthropic/claude-opus-4-7": 1_000_000 }),
    getHasSquad: () => false,
    orchestratorModel: null,
  });

  const last = target.parts[target.parts.length - 1];
  expect(last.text).toContain(CONTEXT_MARKER);
  expect(last.text).toContain("50%"); // 500k / 1M
});

test("applyOrchestratorTransform does nothing when there's no injection target", async () => {
  const messages = [userMsg({ agent: "grunt-anthropic-claude-opus-5" })];
  let called = false;
  await applyOrchestratorTransform(messages, {
    orchestratorAgent: ORCH,
    getInventory: async () => {
      called = true;
      return "";
    },
    getLimitMap: async () => ({}),
    getHasSquad: () => false,
    orchestratorModel: null,
  });
  expect(called).toBe(false);
});
