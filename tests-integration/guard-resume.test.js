// Suite: the rate-limit guard on a child the orchestrator resumes by session
// id, in the real OpenCode 2.1.3 host, offline (see plugin-host.test.js).
// A resume emits session.execution.started with no new session.created, so
// this pins that the host delivers what the guard needs to watch the second
// execution; tests/guard-host.test.js covers the same flow on a simulated host.

import { Effect } from "effect";
import { expect, test } from "vitest";
import { model, PLUGIN_DIR, TestLLM, withHost } from "./host.js";

/** The host's first call titles the session and carries no tools. */
const isTitleRequest = (request) => (request.tools ?? []).length === 0;

/** The child session id the subagent tool reported, e.g. in its result. */
const SESSION_ID = /sessionID[=:]\s*\\?"?(ses_[A-Za-z0-9]+)/;

test("FR-036: a child resumed by session id after a completed run is interrupted when it hangs, and its orchestrator told once", async () => {
  const out = await withHost(
    (h) =>
      Effect.gen(function* () {
        let parentTurns = 0;
        /** @type {string | undefined} */
        let childID;
        yield* h.llm.serve((request) => {
          if (isTitleRequest(request)) return TestLLM.text("Title", "title");
          const body = JSON.stringify(request.messages ?? request);
          if (body.includes("CHILD-TASK") && !body.includes("PARENT-ASK")) {
            // The same child's second execution never yields: the silent hang.
            if (body.includes("CHILD-RESUME")) return TestLLM.hangAfter();
            return TestLLM.text("child finished", "answer");
          }
          parentTurns++;
          if (parentTurns === 1) {
            // Foreground, so the call returns only once the first execution ended.
            return TestLLM.tool("call-first", "subagent", {
              agent: "grunt-test",
              description: "first run",
              prompt: "CHILD-TASK",
            });
          }
          if (parentTurns === 2) {
            childID = body.match(SESSION_ID)?.[1];
            // Without an id the host would spawn a fresh child and the test
            // would pass without exercising a resume.
            if (!childID) throw new Error("the first subagent result named no sessionID");
            return TestLLM.tool("call-resume", "subagent", {
              agent: "grunt-test",
              description: "resumed run",
              prompt: "CHILD-RESUME",
              sessionID: childID,
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
        const child = childID ? yield* h.opencode.sessions.context({ sessionID: childID }) : [];
        return { context, child, childID };
      }),
    {
      agents: { "grunt-test": { mode: "subagent", description: "test grunt" } },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
      plugins: [{ package: PLUGIN_DIR, options: { rate_limit_guard: { max_silence_seconds: 3 } } }],
    },
  );
  const { childID } = out;
  expect(childID).toBeTruthy();

  // Both subagent calls name the same child: the second resumed it.
  const toolText = (/** @type {string} */ id) =>
    JSON.stringify(
      out.context.flatMap((m) => m.content ?? []).find((p) => p.type === "tool" && p.id === id)
        ?.state ?? null,
    );
  const first = toolText("call-first");
  expect(first).toContain('"status":"completed"');
  expect(first).toContain("child finished");
  expect(first.match(SESSION_ID)?.[1]).toBe(childID);
  expect(toolText("call-resume").match(SESSION_ID)?.[1]).toBe(childID);

  // One child session, two executions: the first finished, the second was resumed.
  /** @type {any[]} */
  const turns = out.child;
  const asks = turns.filter((m) => m.type === "user").map((m) => m.text);
  expect(asks).toHaveLength(2);
  expect(asks[0]).toContain("CHILD-TASK");
  expect(asks[1]).toBe("CHILD-RESUME");
  const finished = turns.findIndex((m) =>
    JSON.stringify(m.content ?? []).includes("child finished"),
  );
  const resumed = turns.findIndex((m) => m.text === "CHILD-RESUME");
  expect(finished).toBeGreaterThanOrEqual(0);
  expect(finished).toBeLessThan(resumed);

  // Exactly one note in the whole parent: none from the first execution.
  const synthetic = out.context.filter((m) => m.type === "synthetic");
  const notes = synthetic.filter((m) => (m.text ?? "").startsWith("[RATE LIMIT GUARD]"));
  expect(notes).toHaveLength(1);
  expect(notes[0].text).toContain("`grunt-test`");
  expect(notes[0].text).toContain("was interrupted");
  // The host confirms it stopped the resumed execution of that same child.
  expect(synthetic).toContainEqual(
    expect.objectContaining({
      metadata: expect.objectContaining({ source: "subagent", childID, state: "cancelled" }),
    }),
  );
}, 90_000);
