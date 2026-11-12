// Suite: src/metrics-cache.js — TTL, per-source merge, and the rule that a
// failed or empty response never overwrites good cached data. fetch is a stub;
// no network. Run: npx vitest run tests/metrics-cache.test.js

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { KEY_METRICS } from "../src/metrics.js";
import {
  fetchDetail,
  isStale,
  LLMBENCH_API,
  readMetrics,
  refreshMetrics,
  SUPERINDEX_URL,
  TTL_MS,
} from "../src/metrics-cache.js";

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "squad-metrics-"));
  dirs.push(d);
  return d;
};

const many = (n, mk) => Array.from({ length: n }, (_, i) => mk(i));
const SI_BODY = { models: many(60, (i) => ({ id: `p/m-${i}`, si_score: i })) };
const IDS_BODY = many(60, (i) => ({ id: `q/m-${i}` }));
const rowsFor = (metric, v) => [{ modelId: "q/m-1", metric, value: v }];

/** Route table -> fetch stub. A value of Error throws, a number is an HTTP status. */
function stubFetch(routes) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const r = routes(url);
    if (r instanceof Error) throw r;
    if (typeof r === "number") return { ok: false, status: r, text: async () => "" };
    return { ok: true, status: 200, text: async () => JSON.stringify(r) };
  };
  return { fetch, calls };
}

const healthy = (v = 0.5) =>
  stubFetch((url) => {
    if (url === SUPERINDEX_URL) return SI_BODY;
    if (url.startsWith(`${LLMBENCH_API}/models?`)) return IDS_BODY;
    const metric = new URL(url).searchParams.get("metric");
    return rowsFor(metric, v);
  });

test("first refresh fetches every source and writes the cache", async () => {
  const dir = tmp();
  const { fetch, calls } = healthy();
  const r = await refreshMetrics({ fetch, dir, now: 1000 });
  expect(r).toEqual({ superindex: "updated", scores: "updated", ids: "updated" });
  expect(calls).toHaveLength(2 + KEY_METRICS.length);
  const data = readMetrics(dir);
  expect(Object.keys(data.superindex.index)).toHaveLength(60);
  expect(data.scores.byMetric.tbench_4_0_accuracy["m-1"].values[0].value).toBe(0.5);
  expect(isStale(data, 1000)).toBe(false);
  expect(isStale(data, 1000 + TTL_MS)).toBe(true);
});

test("within the TTL nothing is fetched", async () => {
  const dir = tmp();
  await refreshMetrics({ fetch: healthy().fetch, dir, now: 0 });
  const { fetch, calls } = healthy();
  const r = await refreshMetrics({ fetch, dir, now: TTL_MS - 1 });
  expect(calls).toHaveLength(0);
  expect(r.superindex).toBe("fresh");
});

test("a failed or shrunken source keeps its previous data", async () => {
  const dir = tmp();
  await refreshMetrics({ fetch: healthy(0.5).fetch, dir, now: 0 });
  const { fetch } = stubFetch((url) => {
    if (url === SUPERINDEX_URL) return { models: [{ id: "p/only-one" }] }; // shrunken
    if (url.startsWith(`${LLMBENCH_API}/models?`)) return new Error("timeout");
    return 503;
  });
  const r = await refreshMetrics({ fetch, dir, now: TTL_MS + 1 });
  expect(r.superindex).toMatch(/^failed: only 1 models/);
  expect(r.ids).toMatch(/^failed/);
  expect(r.scores).toMatch(/^failed/);
  const data = readMetrics(dir);
  expect(Object.keys(data.superindex.index)).toHaveLength(60);
  expect(data.superindex.fetchedAt).toBe(0); // still stale -> retried next tick
});

test("an empty 200 for one metric keeps that metric's old rows", async () => {
  const dir = tmp();
  await refreshMetrics({ fetch: healthy(0.5).fetch, dir, now: 0 });
  const { fetch } = stubFetch((url) => {
    if (url === SUPERINDEX_URL) return SI_BODY;
    if (url.startsWith(`${LLMBENCH_API}/models?`)) return IDS_BODY;
    const metric = new URL(url).searchParams.get("metric");
    return metric === "tbench_4_0_accuracy" ? [] : rowsFor(metric, 0.9);
  });
  const r = await refreshMetrics({ fetch, dir, now: TTL_MS + 1 });
  expect(r.scores).toBe("updated (kept old: tbench_4_0_accuracy)");
  const by = readMetrics(dir).scores.byMetric;
  expect(by.tbench_4_0_accuracy["m-1"].values[0].value).toBe(0.5);
  expect(by.epoch_apex_agents["m-1"].values[0].value).toBe(0.9);
});

test("fetchDetail caches per model and serves a stale copy when the fetch fails", async () => {
  const dir = tmp();
  const ok = stubFetch(() => ({ id: "z-ai/glm-5.3", scores: [{ metric: "x", value: 1 }] }));
  const a = await fetchDetail({ fetch: ok.fetch, dir, now: 0, llmbId: "z-ai/glm-5.3" });
  expect(a.id).toBe("z-ai/glm-5.3");
  expect(ok.calls[0]).toBe(`${LLMBENCH_API}/models/z-ai%2Fglm-5.3`);

  const again = stubFetch(() => new Error("should not be called"));
  await fetchDetail({ fetch: again.fetch, dir, now: TTL_MS - 1, llmbId: "z-ai/glm-5.3" });
  expect(again.calls).toHaveLength(0);

  const down = stubFetch(() => new Error("down"));
  const stale = await fetchDetail({
    fetch: down.fetch,
    dir,
    now: TTL_MS + 1,
    llmbId: "z-ai/glm-5.3",
  });
  expect(stale.id).toBe("z-ai/glm-5.3");
  expect(await fetchDetail({ fetch: down.fetch, dir, now: 0, llmbId: "x/none" })).toBeNull();
});
