// Fetch and cache model metrics (see metrics.js) in the OS temp dir.
//
// The plugin refreshes at startup and then whenever a source is older than
// TTL_MS. Each source is fetched in parallel under its own timeout and merged
// into the cache on its own: a source that fails, or answers 200 with an
// empty or shrunken body, keeps its previous data instead of overwriting it.
// That is the exact failure the old Artificial Analysis cron had — a free
// endpoint returned nulls and the daily job committed them over good data.
//
// Per-model detail (every score for one model) is fetched lazily on request
// and cached per model under the same TTL.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { indexModelIds, indexScoreRows, indexSuperIndex, KEY_METRICS } from "./metrics.js";

export const TTL_MS = 48 * 3600_000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 8 * 1024 * 1024;

export const SUPERINDEX_URL = "https://superindex.app/api/v1/models.json";
export const LLMBENCH_API = "https://api.llmbenchmark.ai/v1";

// A response smaller than this is treated as broken, not as "the world shrank".
const MIN_SUPERINDEX_MODELS = 50;
const MIN_LLMBENCH_MODELS = 50;

const CACHE_FILE = "metrics.json";

/** Per-user dir under the OS temp dir. */
export function metricsDir() {
  let user = "user";
  try {
    user = String(os.userInfo().uid ?? os.userInfo().username);
  } catch {
    // userInfo can throw in odd containers; the shared name is still fine.
  }
  return path.join(os.tmpdir(), `opencode-squad-${user}`);
}

/** @param {string} file */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** tmp + rename so a concurrent reader never sees a half-written file. */
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

/** @param {string} dir */
export function readMetrics(dir) {
  const data = readJson(path.join(dir, CACHE_FILE));
  return data && typeof data === "object" ? data : null;
}

/**
 * Whether any source is missing or older than TTL_MS.
 *
 * @param {any} data  readMetrics result
 * @param {number} now
 */
export function isStale(data, now) {
  const at = (s) => (typeof s?.fetchedAt === "number" ? s.fetchedAt : -Infinity);
  const oldest = Math.min(at(data?.superindex), at(data?.scores), at(data?.ids));
  return now - oldest >= TTL_MS;
}

/**
 * @param {typeof globalThis.fetch} fetch
 * @param {string} url
 * @param {number} timeoutMs
 */
async function getJson(fetch, url, timeoutMs) {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error(`response too large: ${url}`);
  return JSON.parse(text);
}

/**
 * One refresh of every source that is stale (or all, with force). Never throws.
 *
 * @param {{fetch: typeof globalThis.fetch, dir: string, now: number,
 *   timeoutMs?: number, force?: boolean}} opts
 * @returns {Promise<{superindex: string, scores: string, ids: string}>}
 *   per source: "fresh" (not due), "updated", or "failed: <reason>"
 */
export async function refreshMetrics({ fetch, dir, now, timeoutMs = FETCH_TIMEOUT_MS, force }) {
  const prev = readMetrics(dir) ?? {};
  const due = (s) => force || !(typeof s?.fetchedAt === "number" && now - s.fetchedAt < TTL_MS);
  const next = { ...prev };
  const report = { superindex: "fresh", scores: "fresh", ids: "fresh" };

  const jobs = [];
  if (due(prev.superindex)) {
    jobs.push(
      getJson(fetch, SUPERINDEX_URL, timeoutMs)
        .then((json) => {
          const index = indexSuperIndex(json);
          const n = Object.keys(index).length;
          if (n < MIN_SUPERINDEX_MODELS) throw new Error(`only ${n} models`);
          next.superindex = { fetchedAt: now, index };
          report.superindex = "updated";
        })
        .catch((e) => {
          report.superindex = `failed: ${e?.message ?? e}`;
        }),
    );
  }
  if (due(prev.scores)) {
    jobs.push(
      Promise.all(
        KEY_METRICS.map(({ metric }) =>
          getJson(
            fetch,
            `${LLMBENCH_API}/scores?metric=${encodeURIComponent(metric)}`,
            timeoutMs,
          ).then(
            (rows) => [metric, indexScoreRows(rows)],
            () => [metric, null],
          ),
        ),
      ).then((results) => {
        const byMetric = { ...(prev.scores?.byMetric ?? {}) };
        const failed = [];
        for (const [metric, index] of results) {
          // An empty 200 is a failure too: keep what we had for this metric.
          if (index && Object.keys(index).length) byMetric[metric] = index;
          else failed.push(metric);
        }
        if (failed.length === results.length) {
          report.scores = `failed: no metric returned rows`;
          return;
        }
        next.scores = { fetchedAt: now, byMetric };
        report.scores = failed.length ? `updated (kept old: ${failed.join(", ")})` : "updated";
      }),
    );
  }
  if (due(prev.ids)) {
    jobs.push(
      getJson(fetch, `${LLMBENCH_API}/models?has_score=true`, timeoutMs)
        .then((list) => {
          const index = indexModelIds(list);
          const n = Object.keys(index).length;
          if (n < MIN_LLMBENCH_MODELS) throw new Error(`only ${n} models`);
          next.ids = { fetchedAt: now, index };
          report.ids = "updated";
        })
        .catch((e) => {
          report.ids = `failed: ${e?.message ?? e}`;
        }),
    );
  }
  if (!jobs.length) return report;
  await Promise.all(jobs);
  if (Object.values(report).some((r) => r.startsWith("updated"))) {
    try {
      writeJsonAtomic(path.join(dir, CACHE_FILE), next);
    } catch {
      // Unwritable temp dir: the next call fetches again.
    }
  }
  return report;
}

/**
 * Every score for one llmbenchmark model id, cached per model for TTL_MS.
 * Falls back to a stale cached copy when the fetch fails. Never throws.
 *
 * @param {{fetch: typeof globalThis.fetch, dir: string, now: number,
 *   llmbId: string, timeoutMs?: number}} opts
 * @returns {Promise<any|null>}
 */
export async function fetchDetail({ fetch, dir, now, llmbId, timeoutMs = FETCH_TIMEOUT_MS }) {
  const file = path.join(dir, "detail", `${llmbId.replace(/[^a-zA-Z0-9._-]+/g, "_")}.json`);
  const cached = readJson(file);
  if (cached && typeof cached.fetchedAt === "number" && now - cached.fetchedAt < TTL_MS) {
    return cached.body;
  }
  try {
    const body = await getJson(
      fetch,
      `${LLMBENCH_API}/models/${encodeURIComponent(llmbId)}`,
      timeoutMs,
    );
    try {
      writeJsonAtomic(file, { fetchedAt: now, body });
    } catch {
      // Serve it uncached.
    }
    return body;
  } catch {
    return cached?.body ?? null;
  }
}
