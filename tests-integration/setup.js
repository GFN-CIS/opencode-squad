// Runs before each integration file: no credentials, no network, no real
// config. Every path the host or the plugin reads (HOME, XDG dirs, TMPDIR)
// points into one throwaway directory, and every outbound fetch fails, so a
// test that passes proves it needed neither.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

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

/** URLs the host or the plugin tried to reach; the in-process host is allowed. */
export const blockedFetches = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (new URL(url).host === "opencode.local") return realFetch(input, init);
  blockedFetches.push(url);
  throw new Error(`network blocked in integration tests: ${url}`);
};

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
