// Suite: the rate-limit guard on provider errors, in the real OpenCode 2.1.3
// host with TestLLM failing the child's model stream (RFC 0001 FR-034,
// FR-035, FR-037).
// Run: npm run test:integration   (Node >= 24)

import { AIError, QuotaExceededError, RateLimitError } from "@opencode/ai";
import { Effect, Stream } from "effect";
import { expect, test } from "vitest";
import { model, PLUGIN_DIR, TestLLM, withHost } from "./host.js";

const isTitleRequest = (request) => (request.tools ?? []).length === 0;
const GUARD = "[RATE LIMIT GUARD]";

/**
 * A parent that dispatches one child, whose every model call fails with
 * `error`; returns the parent's context once a guard note arrived (or after
 * the wait ran out).
 *
 * @param {() => unknown} error
 * @param {Record<string, unknown>} [guard]  rate_limit_guard options
 */
const parentWithFailingChild = (error, guard = {}) =>
  withHost(
    (h) =>
      Effect.gen(function* () {
        let parentTurns = 0;
        yield* h.llm.serve((request) => {
          if (isTitleRequest(request)) return TestLLM.text("Title", "title");
          const body = JSON.stringify(request.messages ?? request);
          if (body.includes("CHILD-TASK") && !body.includes("PARENT-ASK")) {
            return Stream.fail(error());
          }
          parentTurns++;
          if (parentTurns === 1) {
            return TestLLM.tool("call-sub", "subagent", {
              agent: "grunt-test",
              description: "limited task",
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
        /** @type {any[]} */
        let context = [];
        for (let i = 0; i < 40; i++) {
          context = yield* h.opencode.sessions.context({ sessionID: session.id });
          if (JSON.stringify(context).includes(GUARD)) break;
          yield* Effect.sleep("500 millis");
        }
        yield* Effect.sleep("2 seconds"); // room for a duplicate, if there were one
        // The vetoed child ends instead of sleeping until the next attempt.
        const childID = [...JSON.stringify(context).matchAll(/ses_[A-Za-z0-9]+/g)]
          .map((m) => m[0])
          .find((id) => id !== session.id);
        const childEnded = childID
          ? yield* h.opencode.sessions.wait({ sessionID: childID }).pipe(
              Effect.timeout("10 seconds"),
              Effect.as(true),
              Effect.catch(() => Effect.succeed(false)),
            )
          : false;
        return {
          context: yield* h.opencode.sessions.context({ sessionID: session.id }),
          childEnded,
        };
      }),
    {
      agents: { "grunt-test": { mode: "subagent", description: "test grunt" } },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
      plugins: [{ package: PLUGIN_DIR, options: { rate_limit_guard: guard } }],
    },
  );

const guardNotes = (context) =>
  context.filter((m) => m.type === "synthetic" && (m.text ?? "").startsWith(GUARD));

test("FR-034, FR-037: a child told to wait past max_wait_seconds is stopped and its parent told once", async () => {
  // The host caps one announced wait at 15 minutes (2.1.3); the threshold
  // sits below that so the host's own cap does not decide the case.
  const context = await parentWithFailingChild(
    () =>
      new AIError({
        reason: new RateLimitError({
          message: "rate limit exceeded",
          retryAfterMs: 7 * 24 * 3600_000,
        }),
      }),
    { max_wait_seconds: 60 },
  );
  const notes = guardNotes(context.context);
  expect(notes).toHaveLength(1);
  expect(context.childEnded).toBe(true);
  expect(notes[0].text).toContain("`grunt-test`");
  expect(notes[0].text).toMatch(/side effects|changed files|ran commands/i);
}, 90_000);

test("FR-035: when a child's run ends on a limit error, its parent is told once", async () => {
  const context = await parentWithFailingChild(
    () =>
      new AIError({
        reason: new QuotaExceededError({ message: "usage limit reached for this plan" }),
      }),
  );
  expect(guardNotes(context.context)).toHaveLength(1);
}, 90_000);
