// Runs before each integration file: no credentials, no network, no real
// config. Every path the host or the plugin reads (HOME, XDG dirs, TMPDIR)
// points into one throwaway directory, and every outbound fetch fails, so a
// test that passes proves it needed neither.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect } from "vitest";
import { unexpectedRequests } from "./network.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "squad-it-"));
for (const [key, dir] of [
  ["HOME", "home"],
  ["XDG_CONFIG_HOME", "config"],
  ["XDG_DATA_HOME", "data"],
  ["XDG_CACHE_HOME", "cache"],
  ["XDG_STATE_HOME", "state"],
  ["TMPDIR", "tmp"],
]) {
  const full = path.join(root, dir);
  fs.mkdirSync(full, { recursive: true });
  process.env[key] = full;
}
// squad_session prints local times; pin the zone so output is stable.
process.env.TZ = "UTC";

/**
 * Requests the host or the plugin tried to send. No host is exempt: the SDK's
 * in-process transport goes through `host.fetch`, never the global fetch, so
 * a global fetch to its "opencode.local" URL is a network call like any other.
 */
const blockedFetches = [];
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (
    init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")
  ).toUpperCase();
  blockedFetches.push({ url, method });
  throw new Error(`network blocked in integration tests: ${url}`);
};

// Every file, whatever it tests: nothing but the expected background GETs
// may have tried to leave, so no model call bypassed TestLLM.
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  expect(unexpectedRequests(blockedFetches)).toEqual([]);
});
