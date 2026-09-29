// Fresh AA benchmarks without a plugin update. CI refreshes src/benchmarks.json
// on master daily; installed plugins pull that file from GitHub into a local
// cache, and the bundled copy stays as the fallback.
//
// Never on the startup path: the plugin reads whichever snapshot is fresher,
// synchronously, and refreshes in the background under a hard timeout. A
// fetched snapshot applies from the NEXT opencode start — swapping benchmark
// numbers mid-process would change the injected inventory and bust the prompt
// cache — so a successful refresh only asks the user to restart.
//
// Throttle: at most one successful check per day; after MAX_FAILURES failed
// attempts the checker goes quiet until that failure window is a day old.
// Concurrent opencode processes are not coordinated — the worst case is one
// extra conditional GET.

import fs from "node:fs";
import path from "node:path";
import { checkSnapshot, SCHEMA_VERSION } from "./benchmarks-schema.js";

const REMOTE_URL =
  "https://raw.githubusercontent.com/GFN-CIS/opencode-squad/master/src/benchmarks.json";
export const REFRESH_INTERVAL_MS = 24 * 3600_000;
export const CHECK_INTERVAL_MS = 3600_000;
export const MAX_FAILURES = 5;
const FETCH_TIMEOUT_MS = 5000;
const MAX_BYTES = 5 * 1024 * 1024;

const CACHE_FILE = "benchmarks.json";
const META_FILE = "benchmarks.meta.json";

/**
 * @param {Record<string, string|undefined>} env
 * @param {string} home
 */
export function cacheDir(env, home) {
  return path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "opencode-squad");
}

/**
 * The fresher of two parsed snapshots by `_meta.generated`, considering only
 * the ones that pass the schema. Bundled wins ties.
 *
 * @param {unknown} bundled
 * @param {unknown} cached
 * @returns {any|null}
 */
export function pickSnapshot(bundled, cached) {
  const valid = [bundled, cached]
    .map((s) => checkSnapshot(s))
    .filter((r) => r.ok)
    .map((r) => /** @type {any} */ (r).snapshot);
  if (!valid.length) return null;
  return valid.reduce((a, b) => (b._meta.generated > a._meta.generated ? b : a));
}

/**
 * @param {{lastSuccess?: number, failures?: number, windowStart?: number}} meta
 * @param {number} now  epoch ms
 */
export function shouldAttempt(meta, now) {
  if (meta.lastSuccess != null && now - meta.lastSuccess < REFRESH_INTERVAL_MS) return false;
  if (
    (meta.failures ?? 0) >= MAX_FAILURES &&
    meta.windowStart != null &&
    now - meta.windowStart < REFRESH_INTERVAL_MS
  ) {
    return false;
  }
  return true;
}

/** @param {string} file */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * The snapshot to run on: the fresher of the bundled file and the cached copy
 * in `dir`. Never throws. `bundledCount` sizes the refresher's minModels guard.
 *
 * @param {string} bundledFile
 * @param {string} dir  cache dir (see cacheDir)
 * @returns {{snapshot: any|null, bundledCount: number}}
 */
export function loadSnapshot(bundledFile, dir) {
  const bundled = readJson(bundledFile);
  return {
    snapshot: pickSnapshot(bundled, readJson(path.join(dir, CACHE_FILE))),
    bundledCount: Object.keys(bundled?.models ?? {}).length,
  };
}

/** tmp + rename so a concurrent reader never sees a half-written file. */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

/**
 * One background refresh step. Never throws.
 *
 * @param {{fetch: typeof globalThis.fetch, dir: string, now: number,
 *   minModels?: number, timeoutMs?: number}} opts
 *   minModels: reject a snapshot with fewer models (a half-empty AA response
 *   that still passes the schema).
 * @returns {Promise<{outcome: "skipped"|"not-modified"|"failed"}
 *   | {outcome: "cached", generated: string}
 *   | {outcome: "schema-ahead", schema: number}>}
 */
export async function refreshOnce({
  fetch,
  dir,
  now,
  minModels = 1,
  timeoutMs = FETCH_TIMEOUT_MS,
}) {
  const metaFile = path.join(dir, META_FILE);
  const cacheFile = path.join(dir, CACHE_FILE);
  const meta = readJson(metaFile) ?? {};
  if (!shouldAttempt(meta, now)) return { outcome: "skipped" };

  const succeed = (etag) => {
    writeJsonAtomic(metaFile, { etag, lastSuccess: now, failures: 0 });
  };

  try {
    fs.mkdirSync(dir, { recursive: true });
    // A 304 is only meaningful if we still hold a usable copy of that version.
    const haveCache = checkSnapshot(readJson(cacheFile)).ok;
    const headers = haveCache && meta.etag ? { "If-None-Match": meta.etag } : undefined;
    const res = await fetch(REMOTE_URL, { headers, signal: AbortSignal.timeout(timeoutMs) });

    if (res.status === 304 && haveCache) {
      succeed(meta.etag);
      return { outcome: "not-modified" };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error("snapshot too large");

    const check = checkSnapshot(JSON.parse(text));
    if (!check.ok && check.reason === "schema-ahead") {
      // No ETag kept: the next daily check downloads again and warns again,
      // until the plugin is updated.
      succeed(undefined);
      return { outcome: "schema-ahead", schema: check.schema };
    }
    if (!check.ok) throw new Error(check.error);
    if (Object.keys(check.snapshot.models).length < minModels) {
      throw new Error("snapshot has too few models");
    }

    writeJsonAtomic(cacheFile, check.snapshot);
    succeed(res.headers.get("etag") ?? undefined);
    return { outcome: "cached", generated: check.snapshot._meta.generated };
  } catch {
    try {
      const fresh = meta.windowStart == null || now - meta.windowStart >= REFRESH_INTERVAL_MS;
      writeJsonAtomic(metaFile, {
        ...meta,
        failures: fresh ? 1 : (meta.failures ?? 0) + 1,
        windowStart: fresh ? now : meta.windowStart,
      });
    } catch {
      // Unwritable cache dir: nothing to remember, nothing to break.
    }
    return { outcome: "failed" };
  }
}

/**
 * The toast a refresh result deserves, or null.
 *
 * @param {Awaited<ReturnType<typeof refreshOnce>>} result
 * @param {string|undefined} loadedGenerated  `_meta.generated` this process runs on
 * @returns {{title: string, message: string, variant: "info"|"warning"}|null}
 */
export function toastFor(result, loadedGenerated) {
  if (result.outcome === "cached" && result.generated > (loadedGenerated ?? "")) {
    return {
      title: "Squad benchmarks updated",
      message: `Benchmarks from ${result.generated} downloaded — restart opencode to use them.`,
      variant: "info",
    };
  }
  if (result.outcome === "schema-ahead") {
    return {
      title: "Squad benchmarks and schema updated",
      message:
        `Fresh benchmarks use schema v${result.schema}, this plugin reads v${SCHEMA_VERSION} — ` +
        "update the opencode-squad plugin and restart opencode.",
      variant: "warning",
    };
  }
  return null;
}
