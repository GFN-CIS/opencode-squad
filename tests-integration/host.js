// The real OpenCode 2 host, embedded, with TestLLM at the model boundary and
// this repository loaded as a plugin from disk the way a user's config loads
// it. Upstream builds its own SDK tests the same way
// (packages/sdk/test/embedded.test.ts at v2.1.3).

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LanguageModel, LLMClient } from "@opencode/ai";
import { OpenAIChat } from "@opencode/ai/protocols";
import { TestLLM } from "@opencode/ai/testing";
import { llmClient } from "@opencode/core/effect/app-node-platform";
import { SessionRunnerModel } from "@opencode/core/session/runner/model";
import { AbsolutePath, Location, OpenCode } from "@opencode/sdk/effect";
import { Effect, Layer } from "effect";

/** The repository root: a plugin path in config must be a directory. */
export const PLUGIN_DIR = fileURLToPath(new URL("..", import.meta.url));

export { TestLLM };

/** A model with tools, so the agent turn carries the tool catalog. */
export const model = SessionRunnerModel.resolved(
  LanguageModel.make({ id: "test-model", provider: "test", route: OpenAIChat.route }),
  {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 200_000, output: 8_192 },
  },
);

/**
 * Boot a host in a temp project, run `body` against it, tear everything down.
 *
 * @template T
 * @param {(h: {opencode: any, llm: any, project: string, location: any, resolved: any[]}) => Effect.Effect<T, any, any>} body
 * @param {Record<string, unknown>} [configExtra]  more opencode.json content
 * @param {{prepare?: (project: string) => Promise<void>}} [opts]
 *   prepare: lay out files before the host starts (the project is also the
 *   host's config dir, so `<project>/agent/*.md` are loaded agent files)
 * @returns {Promise<T>}
 */
export function withHost(body, configExtra = {}, { prepare } = {}) {
  /** Every session the runner resolved a model for, as the host passed it. */
  const resolved = [];
  const program = Effect.gen(function* () {
    const project = yield* Effect.acquireRelease(
      Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "squad-it-project-"))),
      (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
    );
    if (prepare) yield* Effect.promise(() => prepare(project));
    const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer()));
    const opencode = yield* OpenCode.create(
      {
        log: { level: "error", emit: () => {} },
        database: { path: path.join(project, "sessions.db") },
        events: { persist: true },
        config: {
          directory: project,
          project: false,
          content: JSON.stringify({ plugins: [PLUGIN_DIR], ...configExtra }),
        },
        plugins: [],
        models: { fetch: false },
        fs: { filewatcher: false },
      },
      {
        overrides: [
          llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
          SessionRunnerModel.node.replace(
            Layer.succeed(SessionRunnerModel.Service, {
              resolve: (/** @type {any} */ session) => {
                resolved.push(session);
                return Effect.succeed(model);
              },
            }),
          ),
        ],
      },
    );
    const location = Location.Ref.make({ directory: AbsolutePath.make(project) });
    return yield* body({ opencode, llm, project, location, resolved });
  });
  return Effect.runPromise(Effect.scoped(program));
}

/**
 * Prompt a fresh session and wait for the turn to settle.
 *
 * @param {{opencode: any, location: any}} h
 * @param {string} text
 */
export const promptAndWait = (h, text) =>
  Effect.gen(function* () {
    const session = yield* h.opencode.sessions.create({ location: h.location, model: model.ref });
    yield* h.opencode.sessions.prompt({ sessionID: session.id, text });
    yield* h.opencode.sessions.wait({ sessionID: session.id }).pipe(Effect.timeout("45 seconds"));
    const context = yield* h.opencode.sessions.context({ sessionID: session.id });
    return { session, context };
  });

/** The text a session's tool call returned, by tool-call id. */
export const toolText = (context, id) =>
  context
    .flatMap((m) => m.content ?? [])
    .find((p) => p.type === "tool" && p.id === id)
    ?.state?.content?.map((c) => c.text ?? "")
    .join("\n") ?? "";

/**
 * One session that runs `js` once through Code Mode's execute tool and
 * returns what it printed.
 *
 * @param {string} js
 * @param {Record<string, unknown>} [configExtra]
 * @param {{agent?: string, prepare?: (project: string) => Promise<void>}} [opts]
 */
export const runCode = (js, configExtra = {}, { agent, prepare } = {}) =>
  withHost(
    (h) =>
      Effect.gen(function* () {
        let called = false;
        yield* h.llm.serve((request) => {
          if ((request.tools ?? []).length === 0) return TestLLM.text("Title", "title");
          if (!called) {
            called = true;
            return TestLLM.tool("t-1", "execute", { code: js });
          }
          return TestLLM.text("done", "answer");
        });
        const session = yield* h.opencode.sessions.create({
          location: h.location,
          model: model.ref,
          ...(agent ? { agent } : {}),
        });
        yield* h.opencode.sessions.prompt({ sessionID: session.id, text: "PARENT-ASK" });
        yield* h.opencode.sessions
          .wait({ sessionID: session.id })
          .pipe(Effect.timeout("45 seconds"));
        return toolText(yield* h.opencode.sessions.context({ sessionID: session.id }), "t-1");
      }),
    configExtra,
    { prepare },
  );
