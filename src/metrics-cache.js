// Fetch and cache model metrics (see metrics.js) in the OS temp dir.
//
// The plugin refreshes at startup and then whenever a source is older than
// TTL_MS. Each source is fetched in parallel under its own timeout and merged
// into the cache on its own: a source that fails, or answers 200 with an
// empty or shrunken body, keeps its previous data instead of overwriting it.
// The llmbenchmark scores are one request per key metric, and each metric
// ages on its own: a failed metric keeps its old rows with their old
// timestamp, so it stays due and is retried at the next check.
// That is the exact failure the old Artificial Analysis cron had — a free
// endpoint returned nulls and the daily job committed them over good data.
//
// Per-model detail (every score for one model) is fetched lazily on request
// and cached per model under the same TTL.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeFileAtomic } from "./fs-atomic.js";
import {
  indexModelIds,
  indexScoreRows,
  indexSuperIndex,
  KEY_METRICS,
  metricFetchedAt,
  SUPERINDEX_FORMAT,
} from "./metrics.js";

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

/** A concurrent reader never sees a half-written cache file. @param {string} file @param {unknown} value */
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(value));
}

/** @param {string} dir */
export function readMetrics(dir) {
  const data = readJson(path.join(dir, CACHE_FILE));
  return data && typeof data === "object" ? data : null;
}

/**
 * The one freshness rule for every cached entry (a metrics source or a
 * per-model detail): fetched less than TTL_MS ago. At exactly TTL_MS it has
 * expired.
 *
 * @param {{fetchedAt?: unknown} | null | undefined} entry
 * @param {number} now
 */
function isFresh(entry, now) {
  return typeof entry?.fetchedAt === "number" && now - entry.fetchedAt < TTL_MS;
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
  /** @param {{fetchedAt?: unknown} | undefined} s */
  const due = (s) => force || !isFresh(s, now);
  const next = { ...prev };
  const report = { superindex: "fresh", scores: "fresh", ids: "fresh" };

  const jobs = [];
  // A block of an earlier format is due whatever its age: its serving facts
  // may belong to another model (see superindexOf). If the refetch fails it
  // is kept, still due, and read with those facts withheld.
  if (due(prev.superindex) || prev.superindex?.format !== SUPERINDEX_FORMAT) {
    jobs.push(
      getJson(fetch, SUPERINDEX_URL, timeoutMs)
        .then((json) => {
          const index = indexSuperIndex(json);
          // Count models, not keys: a row is indexed by basename, by
          // provider/basename and by raw id ("=..."), and only basenames are
          // free of both "/" and a leading "=".
          const n = Object.keys(index).filter((k) => !k.includes("/") && !k.startsWith("=")).length;
          if (n < MIN_SUPERINDEX_MODELS) throw new Error(`only ${n} models`);
          next.superindex = { fetchedAt: now, format: SUPERINDEX_FORMAT, index };
          report.superindex = "updated";
        })
        .catch((e) => {
          report.superindex = `failed: ${e?.message ?? e}`;
        }),
    );
  }
  const dueMetrics = KEY_METRICS.map(({ metric }) => metric).filter(
    (metric) => force || !isFresh({ fetchedAt: metricFetchedAt(prev.scores, metric) }, now),
  );
  if (dueMetrics.length) {
    jobs.push(
      Promise.all(
        dueMetrics.map((metric) =>
          getJson(
            fetch,
            `${LLMBENCH_API}/scores?metric=${encodeURIComponent(metric)}`,
            timeoutMs,
          ).then(
            (rows) => /** @type {const} */ ([metric, indexScoreRows(rows)]),
            () => /** @type {const} */ ([metric, null]),
          ),
        ),
      ).then((results) => {
        const byMetric = { ...(prev.scores?.byMetric ?? {}) };
        // Start from the resolved times so an old-format cache keeps its age.
        /** @type {Record<string, number>} */
        const fetchedAtByMetric = {};
        for (const { metric } of KEY_METRICS) {
          const at = metricFetchedAt(prev.scores, metric);
          if (typeof at === "number") fetchedAtByMetric[metric] = at;
        }
        const failed = [];
        for (const [metric, index] of results) {
          // An empty 200 is a failure too: keep what we had for this metric,
          // and its age, so it is retried at the next check.
          if (index && Object.keys(index).length) {
            byMetric[metric] = index;
            fetchedAtByMetric[metric] = now;
          } else failed.push(metric);
        }
        if (failed.length === results.length) {
          report.scores = `failed: no metric returned rows`;
          return;
        }
        next.scores = { fetchedAtByMetric, byMetric };
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
  if (isFresh(cached, now)) {
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
