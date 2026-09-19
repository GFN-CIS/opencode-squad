import { expect, test } from "vitest";
import { BOOTSTRAP_MARKER } from "../src/bootstrap.js";
import { CONTEXT_MARKER } from "../src/context.js";
import {
  applyOrchestratorTransform,
  createTurnMemo,
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

// The cache fix. The transform fires once per MODEL CALL, so a turn with forty
// tool calls runs it forty times; if the text it injects differs between those
// calls, Anthropic's prefix-matched cache cannot read back anything at or after
// it. These two tests are the only pre-deployment evidence the block is stable
// — the injection is never persisted, so it cannot be observed from the DB.
test("the injected block is byte-identical across calls within one turn", async () => {
  const turnMemo = createTurnMemo();
  const opts = {
    orchestratorAgent: ORCH,
    getInventory: async () => "- `grunt-x`: worker (model: p/m)",
    getLimitMap: async () => ({ "p/m": 1_000_000 }),
    getHasSquad: () => true,
    orchestratorModel: "p/m",
    turnMemo,
  };

  const first = {
    info: { role: "user", agent: ORCH, id: "msg_turn1" },
    parts: [{ type: "text", text: "go" }],
  };
  await applyOrchestratorTransform(
    [
      assistantMsg({
        providerID: "p",
        modelID: "m",
        tokens: { input: 10, output: 5, cache: { read: 1000, write: 0 } },
      }),
      first,
    ],
    opts,
  );
  const firstTexts = first.parts.map((p) => p.text);

  // Same turn, later call: a fresh copy of the stored message (injections are
  // not persisted) and a bigger context — the growth must NOT change the text.
  const later = {
    info: { role: "user", agent: ORCH, id: "msg_turn1" },
    parts: [{ type: "text", text: "go" }],
  };
  await applyOrchestratorTransform(
    [
      assistantMsg({
        providerID: "p",
        modelID: "m",
        tokens: { input: 10, output: 5, cache: { read: 400_000, write: 0 } },
      }),
      later,
    ],
    opts,
  );

  expect(later.parts.map((p) => p.text)).toEqual(firstTexts);
});

test("a new turn gets a freshly built block", async () => {
  const turnMemo = createTurnMemo();
  let inventory = "- `grunt-x`: worker (model: p/m)";
  const opts = {
    orchestratorAgent: ORCH,
    getInventory: async () => inventory,
    getLimitMap: async () => ({ "p/m": 1_000_000 }),
    getHasSquad: () => true,
    orchestratorModel: "p/m",
    turnMemo,
  };
  const mk = (id) => ({
    info: { role: "user", agent: ORCH, id },
    parts: [{ type: "text", text: "go" }],
  });

  const t1 = mk("msg_turn1");
  await applyOrchestratorTransform([t1], opts);
  inventory = "- `grunt-y`: a different squad (model: p/m)";
  const t2 = mk("msg_turn2");
  await applyOrchestratorTransform([t2], opts);

  expect(t2.parts[0].text).not.toBe(t1.parts[0].text);
  expect(t2.parts[0].text).toContain("grunt-y");
});

test("the memo is bounded, so concurrent orchestrator sessions cannot evict each other into rebuilding", async () => {
  const turnMemo = createTurnMemo(2);
  turnMemo.set("a", { bootstrap: "A", contextLine: null });
  turnMemo.set("b", { bootstrap: "B", contextLine: null });
  expect(turnMemo.get("a")?.bootstrap).toBe("A");
  turnMemo.set("c", { bootstrap: "C", contextLine: null });
  expect(turnMemo.get("a")).toBe(null); // oldest evicted, not the whole map
  expect(turnMemo.get("b")?.bootstrap).toBe("B");
  expect(turnMemo.get("c")?.bootstrap).toBe("C");
});

test("without a message id the block is rebuilt — no stable key to memo on", async () => {
  const turnMemo = createTurnMemo();
  let calls = 0;
  const opts = {
    orchestratorAgent: ORCH,
    getInventory: async () => {
      calls++;
      return "(no subagents available)";
    },
    getLimitMap: async () => ({}),
    getHasSquad: () => false,
    orchestratorModel: null,
    turnMemo,
  };
  await applyOrchestratorTransform([userMsg({ text: "go" })], opts);
  await applyOrchestratorTransform([userMsg({ text: "go" })], opts);
  expect(calls).toBe(2);
});
