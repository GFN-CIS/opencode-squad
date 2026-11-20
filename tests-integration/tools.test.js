// Suite: the squad tools' reports in the real OpenCode 2.1.3 host, offline
// (RFC 0001 FR-040, FR-041, FR-043, FR-044, FR-047).
// Run: npm run test:integration   (Node >= 24)

import fs from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, expect, test } from "vitest";
import { indexSuperIndex, SUPERINDEX_FORMAT } from "../src/metrics.js";
import { metricsDir } from "../src/metrics-cache.js";
import { model, runCode, TestLLM, toolText, withHost } from "./host.js";

const storeFile = () => path.join(process.env.XDG_CONFIG_HOME ?? "", "opencode", "squad.json");
const metricsFile = () => path.join(metricsDir(), "metrics.json");
afterEach(async () => {
  await fs.rm(storeFile(), { force: true });
  await fs.rm(metricsFile(), { force: true });
});

const isTitleRequest = (request) => (request.tools ?? []).length === 0;
const code = (id, js) => TestLLM.tool(id, "execute", { code: js });
const GLOBAL_ALLOW = { permissions: [{ action: "*", resource: "*", effect: "allow" }] };

test("FR-040, FR-041, FR-047: squad_metrics offline keeps the cached figures, marks roles, says quota unknown", async () => {
  await fs.mkdir(path.dirname(storeFile()), { recursive: true });
  await fs.writeFile(
    storeFile(),
    JSON.stringify({ version: 1, grunts: { "test/test-model": {} }, drills: {} }),
  );
  // Older than the refresh age, so the plugin tries to refetch and fails offline.
  await fs.mkdir(metricsDir(), { recursive: true });
  await fs.writeFile(
    metricsFile(),
    JSON.stringify({
      superindex: {
        fetchedAt: Date.now() - 72 * 3600_000,
        format: SUPERINDEX_FORMAT,
        index: indexSuperIndex({ models: [{ id: "test/test-model", si_score: 77.7, rank: 3 }] }),
      },
    }),
  );
  const text = await runCode(
    'return await tools.squad_metrics({models: ["test/test-model", "other/m"]})',
    GLOBAL_ALLOW,
  );
  const line = text.split("\n").find((l) => l.startsWith("- test/test-model")) ?? "";
  expect(line).toContain("[grunt]");
  expect(line).toContain("SI 77.7 #3");
  // A model the sources do not hold borrows nothing from another.
  expect(text).not.toMatch(/- other\/m[^\n]*SI 77\.7/);
  expect(text).toContain("Provider quota, last seen in this process:");
  expect(text).toContain("- test: unknown (no rate-limit headers seen from this provider)");
  expect(text).toContain("- other: unknown");
}, 120_000);

/**
 * A parent dispatches one grunt whose run answers with `child`; once it has
 * ended, the parent runs `check(childID)` through Code Mode and the text it
 * returned comes back.
 *
 * @param {() => any} childResponse
 * @param {(id: string) => string} check
 */
const afterChild = (childResponse, check) =>
  withHost(
    (h) =>
      Effect.gen(function* () {
        let parentTurns = 0;
        /** @type {string | undefined} */
        let child;
        yield* h.llm.serve((request) => {
          if (isTitleRequest(request)) return TestLLM.text("Title", "title");
          const body = JSON.stringify(request.messages ?? request);
          if (body.includes("CHILD-TASK") && !body.includes("PARENT-ASK")) {
            return childResponse();
          }
          parentTurns++;
          if (parentTurns === 1) {
            return TestLLM.tool("call-sub", "subagent", {
              agent: "grunt-test",
              description: "capped task",
              prompt: "CHILD-TASK",
              background: true,
            });
          }
          if (body.includes("CHECK") && child) {
            const id = child;
            child = undefined;
            return code("t-s", check(id));
          }
          return TestLLM.text(`parent turn ${parentTurns}`, "answer");
        });
        const session = yield* h.opencode.sessions.create({
          location: h.location,
          model: model.ref,
        });
        yield* h.opencode.sessions.prompt({ sessionID: session.id, text: "PARENT-ASK" });
        // The child's id is in the subagent stub; wait for its run to end.
        for (let i = 0; i < 60 && !child; i++) {
          const ctx = JSON.stringify(yield* h.opencode.sessions.context({ sessionID: session.id }));
          child = [...ctx.matchAll(/ses_[A-Za-z0-9]+/g)]
            .map((m) => m[0])
            .find((id) => id !== session.id);
          if (!child) yield* Effect.sleep("500 millis");
        }
        yield* h.opencode.sessions.wait({ sessionID: child }).pipe(Effect.timeout("45 seconds"));
        yield* h.opencode.sessions
          .wait({ sessionID: session.id })
          .pipe(Effect.timeout("45 seconds"));
        yield* h.opencode.sessions.prompt({ sessionID: session.id, text: "CHECK" });
        yield* h.opencode.sessions
          .wait({ sessionID: session.id })
          .pipe(Effect.timeout("45 seconds"));
        return toolText(yield* h.opencode.sessions.context({ sessionID: session.id }), "t-s");
      }),
    {
      agents: { "grunt-test": { mode: "subagent", description: "test grunt" } },
      ...GLOBAL_ALLOW,
    },
  );

test("FR-043: squad_session says a child cut at the output cap was truncated, not refused", async () => {
  const text = await afterChild(
    () =>
      TestLLM.complete({
        reason: { normalized: "length" },
        usage: { inputTokens: 100, outputTokens: 9000, reasoningTokens: 8991 },
      }),
    (id) => `return await tools.squad_session({sessionIDs: ["${id}"]})`,
  );
  expect(text).toContain("[TASK OUTCOME]");
  expect(text).toContain("finish=length");
  expect(text).toMatch(/not because the provider refused/);
}, 150_000);

test("FR-044: squad_compact compacts a grunt's session and reports its size", async () => {
  const text = await afterChild(
    () => TestLLM.textWithUsage("child result", "answer", 50_000),
    (id) => `return await tools.squad_compact({sessionID: "${id}"})`,
  );
  expect(text).toMatch(/^\[COMPACTED\] grunt-test session ses_\w+ — /);
}, 150_000);
