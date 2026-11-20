// Suite: the plugin inside the real OpenCode 2.1.3 host, offline. TestLLM
// scripts the model; no credentials, no network (tests-integration/setup.js).
// Run: npm run test:integration   (Node >= 24)

import { Effect } from "effect";
import { expect, test } from "vitest";
import { model, PLUGIN_DIR, promptAndWait, TestLLM, withHost } from "./host.js";

/** The host's first call titles the session and carries no tools. */
const isTitleRequest = (request) => (request.tools ?? []).length === 0;

test("FR-029: the plugin loads from disk and its bootstrap reaches the orchestrator's system prompt", async () => {
  const out = await withHost((h) =>
    Effect.gen(function* () {
      yield* h.llm.serve((request) =>
        isTitleRequest(request)
          ? TestLLM.text("Title", "title")
          : TestLLM.text("scripted reply", "answer"),
      );
      const { context } = yield* promptAndWait(h, "hello");
      const plugins = yield* h.opencode.plugin.list({ location: h.location });
      const requests = yield* h.llm.requests();
      return { context, plugins, requests };
    }),
  );
  const ours = JSON.stringify(out.plugins);
  expect(ours).toContain('"squad"');
  expect(ours).toContain("active");
  expect(JSON.stringify(out.context)).toContain("scripted reply");
  const turn = out.requests.find((r) => !isTitleRequest(r));
  // The context hook appended the bootstrap, and the squad tools are in the catalog.
  expect(JSON.stringify(turn?.system ?? null)).toContain("squad_session");
  expect(JSON.stringify(turn ?? null)).toContain("tools.squad_session(");
});

test("FR-042: a scripted tool call reaches squad_session in the real host and returns its report", async () => {
  const out = await withHost((h) =>
    Effect.gen(function* () {
      let called = false;
      yield* h.llm.serve((request) => {
        if (isTitleRequest(request)) return TestLLM.text("Title", "title");
        if (!called) {
          called = true;
          // OpenCode 2 exposes plugin tools through Code Mode's execute tool.
          return TestLLM.tool("call-squad", "execute", {
            code: "return await tools.squad_session({})",
          });
        }
        return TestLLM.text("done", "answer");
      });
      const { context } = yield* promptAndWait(h, "check the session");
      return { context };
    }),
  );
  const part = out.context
    .flatMap((m) => m.content ?? [])
    .find((p) => p.type === "tool" && p.id === "call-squad");
  expect(part?.state?.status).toBe("completed");
  const calls = part?.state?.metadata?.toolCalls ?? [];
  expect(calls).toContainEqual(
    expect.objectContaining({ tool: "squad_session", status: "completed" }),
  );
  expect(part?.state?.content?.[0]?.text ?? "").toMatch(/^now: /);
});

test("FR-036: a subagent whose model stream hangs is interrupted, and its orchestrator told once", async () => {
  const out = await withHost(
    (h) =>
      Effect.gen(function* () {
        let parentTurns = 0;
        yield* h.llm.serve((request) => {
          if (isTitleRequest(request)) return TestLLM.text("Title", "title");
          const body = JSON.stringify(request.messages ?? request);
          // The child's stream never yields: the silent hang the guard exists for.
          if (body.includes("CHILD-TASK") && !body.includes("PARENT-ASK")) {
            return TestLLM.hangAfter();
          }
          parentTurns++;
          if (parentTurns === 1) {
            return TestLLM.tool("call-sub", "subagent", {
              agent: "grunt-test",
              description: "hanging task",
              prompt: "CHILD-TASK",
              background: true,
            });
          }
          return TestLLM.text(`parent turn ${parentTurns}`, "answer");
        });
        const session = yield* h.opencode.sessions.create({
          location: h.location,
          model: model.ref,
        });
        yield* h.opencode.sessions.prompt({ sessionID: session.id, text: "PARENT-ASK" });
        // The guard polls every 15 s; wait for its note rather than a fixed time.
        /** @type {any[]} */
        let context = [];
        for (let i = 0; i < 60; i++) {
          context = yield* h.opencode.sessions.context({ sessionID: session.id });
          if (JSON.stringify(context).includes("[RATE LIMIT GUARD]")) break;
          yield* Effect.sleep("1 second");
        }
        yield* Effect.sleep("2 seconds"); // room for a duplicate, if there were one
        context = yield* h.opencode.sessions.context({ sessionID: session.id });
        return { context };
      }),
    {
      agents: { "grunt-test": { mode: "subagent", description: "test grunt" } },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
      plugins: [{ package: PLUGIN_DIR, options: { rate_limit_guard: { max_silence_seconds: 3 } } }],
    },
  );
  const synthetic = out.context.filter((m) => m.type === "synthetic");
  const notes = synthetic.filter((m) => (m.text ?? "").startsWith("[RATE LIMIT GUARD]"));
  expect(notes).toHaveLength(1);
  expect(notes[0].text).toContain("`grunt-test`");
  expect(notes[0].text).toContain("was interrupted");
  // The host confirms the child was stopped.
  expect(synthetic).toContainEqual(
    expect.objectContaining({
      metadata: expect.objectContaining({ source: "subagent", state: "cancelled" }),
    }),
  );
}, 90_000);
