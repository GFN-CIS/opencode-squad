import { describe, expect, test } from "vitest";
import { BOOTSTRAP_MARKER } from "../src/bootstrap.js";
import { buildLimitMap, buildVariantMap, estimateContextTokens } from "../src/context.js";
import { formatInventory, hasSquad } from "../src/inventory.js";
import { createTurnMemo } from "../src/message-transform.js";
import { PROMPT_CLOSE, promptOpen } from "../src/prompt-inject.js";
import { evaluateRetry, initGuardState, normalizeGuardConfig } from "../src/rate-limit-guard.js";
import {
  appendToResult,
  applyOrchestratorTransformV2,
  applySystemPartsTransform,
  findV2InjectionTarget,
  lastAssistantModel,
  normalizeAgents,
  normalizeProviders,
  normalizeUsageMessages,
  retryToStatus,
  subagentOutcome,
} from "../src/v2/adapt.js";

// Payload shapes trimmed from OpenCode 2.1.3 captures.
const v2Agents = [
  { id: "build", name: "Build", mode: "primary", hidden: false, permissions: [] },
  {
    id: "grunt-glm",
    name: "Grunt Glm",
    mode: "subagent",
    description: "cheap edits",
    model: { id: "glm-5.3", providerID: "zai", variant: "low" },
  },
  { id: "general", name: "General", mode: "subagent", description: "general" },
];

const v2Models = [
  {
    id: "glm-5.3",
    providerID: "zai",
    limit: { context: 200000, output: 32000 },
    variants: [
      { id: "low", settings: { reasoningEffort: "low" } },
      { id: "max", settings: { reasoningEffort: "max" } },
    ],
  },
  { id: "big-pickle", providerID: "opencode", limit: { context: 128000 }, variants: [] },
];

const childContext = [
  { id: "u1", type: "user", time: { created: 1000 }, text: "do it" },
  {
    id: "a1",
    type: "assistant",
    time: { created: 1100, completed: 1200 },
    agent: "grunt-glm",
    model: { id: "glm-5.3", providerID: "zai" },
    content: [{ type: "text", text: "done" }],
    finish: "stop",
    tokens: { input: 900, output: 40, reasoning: 10, cache: { read: 50, write: 0 } },
  },
  { id: "i1", type: "idle", time: { created: 1300 }, outcome: "succeeded" },
];

describe("agents and providers", () => {
  test("normalizeAgents uses the id as the name and reshapes the model", () => {
    const agents = normalizeAgents(v2Agents);
    expect(agents[1]).toEqual({
      name: "grunt-glm",
      mode: "subagent",
      description: "cheap edits",
      model: { providerID: "zai", modelID: "glm-5.3" },
    });
    expect(agents[0].model).toBeUndefined();
    expect(hasSquad(agents)).toBe(true);
    expect(formatInventory(agents)).toContain("`grunt-glm`: cheap edits (model: zai/glm-5.3)");
    expect(normalizeAgents(undefined)).toEqual([]);
  });

  test("normalizeProviders feeds buildLimitMap and buildVariantMap", () => {
    const providers = normalizeProviders(v2Models);
    expect(buildLimitMap(providers)).toMatchObject({ "zai/glm-5.3": 200000, "glm-5.3": 200000 });
    expect(buildVariantMap(providers)).toEqual({
      "zai/glm-5.3": ["low", "max"],
      "opencode/big-pickle": [],
    });
    expect(normalizeProviders(null)).toEqual([]);
  });
});

describe("messages", () => {
  test("normalizeUsageMessages keeps what the usage scans read", () => {
    const items = normalizeUsageMessages(childContext);
    expect(items).toHaveLength(2);
    expect(items[1].info).toMatchObject({
      role: "assistant",
      finish: "stop",
      modelID: "glm-5.3",
      providerID: "zai",
    });
    expect(estimateContextTokens(items)).toEqual({
      used: 1000,
      modelID: "glm-5.3",
      providerID: "zai",
    });
    expect(normalizeUsageMessages("nope")).toEqual([]);
  });

  test("lastAssistantModel reads the newest assistant message", () => {
    expect(lastAssistantModel(childContext)).toEqual({ providerID: "zai", modelID: "glm-5.3" });
    expect(lastAssistantModel([])).toBeNull();
    expect(lastAssistantModel(undefined)).toBeNull();
  });
});

describe("subagent results", () => {
  const result = {
    output: { sessionID: "ses_child", status: "completed", output: "PONG" },
    content: [{ type: "text", text: '<subagent sessionID="ses_child">\nPONG\n</subagent>' }],
    metadata: { sessionID: "ses_child", status: "completed" },
  };

  test("subagentOutcome reads the child session and final text", () => {
    expect(subagentOutcome(result)).toEqual({ sessionID: "ses_child", output: "PONG" });
    expect(subagentOutcome({})).toEqual({ sessionID: undefined, output: "" });
  });

  test("appendToResult adds a text part or a paragraph", () => {
    expect(appendToResult(result, "NOTE").content.at(-1)).toEqual({ type: "text", text: "NOTE" });
    expect(result.content).toHaveLength(1); // not mutated
    expect(appendToResult({ content: "x" }, "NOTE").content).toBe("x\n\nNOTE");
    expect(appendToResult({}, "NOTE").content).toBe("NOTE");
  });
});

describe("system prompt refresh", () => {
  const fenced = `${promptOpen("grunt")}\nOLD\n${PROMPT_CLOSE}\nnotes`;

  test("replaces the fenced body in the first fenced text part", () => {
    const system = [
      { type: "text", text: "harness" },
      { type: "text", text: fenced },
    ];
    const r = applySystemPartsTransform(system, () => "NEW BODY");
    expect(r).toMatchObject({ applied: true, role: "grunt", changed: true });
    expect(system[1].text).toContain("NEW BODY");
    expect(system[1].text).not.toContain("OLD");
    expect(system[1].text.endsWith("notes")).toBe(true);
    expect(system[0].text).toBe("harness");
  });

  test("no fence or no loader body leaves the parts alone", () => {
    const system = [{ type: "text", text: "plain" }];
    expect(applySystemPartsTransform(system, () => "X")).toEqual({ applied: false });
    const withFence = [{ type: "text", text: fenced }];
    expect(applySystemPartsTransform(withFence, () => null).applied).toBe(false);
    expect(withFence[0].text).toBe(fenced);
    expect(applySystemPartsTransform(undefined, () => "X")).toEqual({ applied: false });
  });
});

describe("retry hook", () => {
  test("retryToStatus turns the proposed delay into an absolute wake-up", () => {
    const event = {
      attempt: 2,
      error: { type: "provider", message: "rate limit, resets in 3h", status: 429 },
      decision: { retry: true, delay: 3 * 3600_000 },
    };
    expect(retryToStatus(event, 1000)).toEqual({
      type: "retry",
      attempt: 2,
      message: "rate limit, resets in 3h",
      next: 1000 + 3 * 3600_000,
    });
    const r = evaluateRetry(
      initGuardState(),
      retryToStatus(event, 1000),
      normalizeGuardConfig(undefined),
      429,
      1000,
    );
    expect(r).toMatchObject({ trigger: true, reason: "single_wait" });
  });

  test("a vetoed or missing delay counts as zero wait", () => {
    expect(retryToStatus({ attempt: 1, decision: { retry: false } }, 5).next).toBe(5);
    expect(retryToStatus({ attempt: 1, decision: { retry: true, delay: -1 } }, 5).next).toBe(5);
  });
});

describe("orchestrator injection", () => {
  const baseOpts = () => {
    const calls = { inventory: 0, usage: 0 };
    return {
      calls,
      opts: {
        orchestratorAgent: "build",
        getInventory: async () => {
          calls.inventory += 1;
          return "- `grunt-glm`: cheap";
        },
        getLimitMap: async () => ({ "zai/glm-5.3": 200000 }),
        getHasSquad: () => true,
        getUsageMessages: async () => {
          calls.usage += 1;
          return normalizeUsageMessages(childContext);
        },
        turnMemo: createTurnMemo(),
      },
    };
  };
  const request = () => ({
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5-5" },
    messages: [
      { id: "m1", role: "user", content: [{ type: "text", text: "first" }] },
      { id: "m2", role: "assistant", content: [{ type: "text", text: "ok" }] },
      { id: "m3", role: "user", content: [{ type: "text", text: "now this" }] },
    ],
  });

  test("findV2InjectionTarget picks the latest user message with text", () => {
    expect(findV2InjectionTarget(request().messages)?.id).toBe("m3");
    expect(findV2InjectionTarget([{ role: "user", content: [{ type: "file" }] }])).toBeNull();
    expect(findV2InjectionTarget(undefined)).toBeNull();
  });

  test("injects bootstrap first and the context line last on the target", async () => {
    const { opts } = baseOpts();
    const event = request();
    await applyOrchestratorTransformV2(event, opts);
    const content = event.messages[2].content;
    expect(content[0].text).toContain(BOOTSTRAP_MARKER);
    expect(content[0].text).toContain("anthropic/claude-opus-5-5");
    expect(content[1].text).toBe("now this");
    expect(content.at(-1).text).toMatch(/context/i);
    expect(event.messages[0].content).toHaveLength(1);
  });

  test("replays the memoized block byte-identically within a turn", async () => {
    const { opts, calls } = baseOpts();
    const first = request();
    await applyOrchestratorTransformV2(first, opts);
    const second = request();
    await applyOrchestratorTransformV2(second, opts);
    expect(second.messages[2].content).toEqual(first.messages[2].content);
    expect(calls.inventory).toBe(1);
    expect(calls.usage).toBe(1);
  });

  test("a new turn rebuilds the inventory instead of reusing the previous block", async () => {
    const { opts, calls } = baseOpts();
    const first = request();
    await applyOrchestratorTransformV2(first, opts);
    opts.getInventory = async () => "- `grunt-new`: new roster";
    const next = request();
    next.messages[2].id = "m4";
    await applyOrchestratorTransformV2(next, opts);
    expect(next.messages[2].content[0].text).toContain("grunt-new");
    expect(next.messages[2].content[0].text).not.toBe(first.messages[2].content[0].text);
    expect(calls.usage).toBe(2);
  });

  test("a target without an id rebuilds instead of caching under a shared missing key", async () => {
    const { opts, calls } = baseOpts();
    for (let i = 0; i < 2; i++) {
      const event = request();
      delete event.messages[2].id;
      await applyOrchestratorTransformV2(event, opts);
      expect(event.messages[2].content[0].text).toContain(BOOTSTRAP_MARKER);
    }
    expect(calls.inventory).toBe(2);
    expect(calls.usage).toBe(2);
  });

  test("skips other agents, already-injected targets, and empty requests", async () => {
    const { opts, calls } = baseOpts();
    const sub = { ...request(), agent: "grunt-glm" };
    await applyOrchestratorTransformV2(sub, opts);
    expect(sub.messages[2].content).toHaveLength(1);

    const injected = request();
    injected.messages[2].content.unshift({ type: "text", text: `${BOOTSTRAP_MARKER} old` });
    await applyOrchestratorTransformV2(injected, opts);
    expect(injected.messages[2].content).toHaveLength(2);

    await applyOrchestratorTransformV2({ agent: "build", messages: [] }, opts);
    expect(calls.inventory).toBe(0);
  });

  test("no usage yet means no context line; no memo means rebuild", async () => {
    const { opts, calls } = baseOpts();
    opts.getUsageMessages = async () => [];
    opts.turnMemo = undefined;
    const event = request();
    event.model = undefined;
    await applyOrchestratorTransformV2(event, opts);
    expect(event.messages[2].content).toHaveLength(2);
    await applyOrchestratorTransformV2(request(), opts);
    expect(calls.inventory).toBe(2);
  });
});
