// Suite: what the plugin puts into requests, in the real OpenCode 2.1.3 host
// (RFC 0001 FR-029 to FR-033).
// Run: npm run test:integration   (Node >= 24)

import fs from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, expect, test } from "vitest";
import { BOOTSTRAP_MARKER } from "../src/bootstrap.js";
import { model, TestLLM, withHost } from "./host.js";

const storeFile = () => path.join(process.env.XDG_CONFIG_HOME ?? "", "opencode", "squad.json");
afterEach(async () => {
  await fs.rm(storeFile(), { force: true });
});

const isTitleRequest = (request) => (request.tools ?? []).length === 0;
const GLOBAL_ALLOW = { permissions: [{ action: "*", resource: "*", effect: "allow" }] };

/** @param {object} roster */
async function writeRoster(roster) {
  await fs.mkdir(path.dirname(storeFile()), { recursive: true });
  await fs.writeFile(
    storeFile(),
    JSON.stringify({ version: 1, grunts: {}, drills: {}, ...roster }),
  );
}

/** The system text of a request, joined. */
const systemOf = (request) =>
  (request.system ?? []).map((p) => (typeof p === "string" ? p : (p.text ?? ""))).join("\n");

/** Every model request two prompts produced, in one session for `agent`. */
const twoTurns = (agent) =>
  withHost(
    (h) =>
      Effect.gen(function* () {
        yield* h.llm.serve((request) =>
          isTitleRequest(request) ? TestLLM.text("Title", "title") : TestLLM.text("ok", "answer"),
        );
        const session = yield* h.opencode.sessions.create({
          location: h.location,
          model: model.ref,
          ...(agent ? { agent } : {}),
        });
        for (const text of ["FIRST-ASK", "SECOND-ASK"]) {
          yield* h.opencode.sessions.prompt({ sessionID: session.id, text });
          yield* h.opencode.sessions
            .wait({ sessionID: session.id })
            .pipe(Effect.timeout("45 seconds"));
        }
        return (yield* h.llm.requests()).filter((r) => !isTitleRequest(r));
      }),
    GLOBAL_ALLOW,
  );

test("FR-029, FR-030, FR-031: the lead gets one stable bootstrap and its messages are untouched", async () => {
  await writeRoster({ grunts: { "p/m": {} } });
  const requests = await twoTurns();
  expect(requests).toHaveLength(2);
  const blocks = requests.map((r) => {
    const sys = systemOf(r);
    const start = sys.indexOf(BOOTSTRAP_MARKER);
    return start < 0 ? "" : sys.slice(start);
  });
  for (const b of blocks) {
    expect(b.split(BOOTSTRAP_MARKER)).toHaveLength(2); // exactly one
    expect(b).toContain("grunt-p-m");
    expect(b).toContain("test/test-model"); // the lead's own model
  }
  expect(blocks[1]).toBe(blocks[0]);
  // No clock in it.
  expect(blocks[0]).not.toMatch(/\b20\d\d-\d\d-\d\d[ T]\d\d:\d\d/);
  // The user's text reaches the model as sent, and nothing else of ours does.
  const messages = JSON.stringify(requests[1].messages);
  expect(messages).toContain("FIRST-ASK");
  expect(messages).toContain("SECOND-ASK");
  expect(messages).not.toContain(BOOTSTRAP_MARKER);
}, 120_000);

test("FR-032: a squad agent's requests carry no bootstrap", async () => {
  await writeRoster({ grunts: { "p/m": {} } });
  const requests = await twoTurns("grunt-p-m");
  expect(requests.length).toBeGreaterThan(0);
  for (const r of requests) expect(systemOf(r)).not.toContain(BOOTSTRAP_MARKER);
}, 120_000);

test("FR-033: with no squad the bootstrap sends the user to squad-draft", async () => {
  const requests = await twoTurns();
  const sys = systemOf(requests[0]);
  expect(sys).toContain(BOOTSTRAP_MARKER);
  expect(sys).toContain("squad-draft");
}, 120_000);
