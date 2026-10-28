import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  cacheDir,
  loadSnapshot,
  MAX_FAILURES,
  pickSnapshot,
  REFRESH_INTERVAL_MS,
  refreshOnce,
  shouldAttempt,
} from "../src/benchmark-cache.js";
import { SCHEMA_VERSION } from "../src/benchmarks-schema.js";

const HOUR = 3600_000;
const NOW = Date.parse("2026-09-29T12:00:00Z");

const entry = {
  name: "M",
  creator: null,
  release_date: null,
  intelligence: 50,
  coding: null,
  math: null,
  agentic: {},
  benchmarks: {},
  price_blended: 1,
  price_input: 1,
  price_output: 1,
  tps: 0,
  ttft: 0,
};
const snap = (generated, meta = {}) => ({
  _meta: { schema: SCHEMA_VERSION, generated, ...meta },
  models: { a: entry, b: entry },
});

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-cache-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const readMeta = () => JSON.parse(fs.readFileSync(path.join(dir, "benchmarks.meta.json"), "utf8"));
const writeMeta = (m) =>
  fs.writeFileSync(path.join(dir, "benchmarks.meta.json"), JSON.stringify(m));
const writeCache = (s) => fs.writeFileSync(path.join(dir, "benchmarks.json"), JSON.stringify(s));

/** A fetch stub that records calls and answers with one canned response. */
function fakeFetch(status, body, headers = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return new Response(status === 304 ? null : JSON.stringify(body), { status, headers });
  };
  fn.calls = calls;
  return fn;
}

const run = (fetch, extra = {}) => refreshOnce({ fetch, dir, now: NOW, minModels: 1, ...extra });

// --- cacheDir -------------------------------------------------------------

test("cache dir honours XDG_CACHE_HOME, else ~/.cache", () => {
  expect(cacheDir({ XDG_CACHE_HOME: "/x" }, "/home/u")).toBe("/x/opencode-squad");
  expect(cacheDir({}, "/home/u")).toBe("/home/u/.cache/opencode-squad");
});

// --- pickSnapshot ---------------------------------------------------------

test("the fresher valid snapshot wins", () => {
  expect(pickSnapshot(snap("2026-09-22"), snap("2026-09-28"))._meta.generated).toBe("2026-09-28");
  // e.g. right after a plugin update the bundled copy is newer than the cache
  expect(pickSnapshot(snap("2026-09-30"), snap("2026-09-28"))._meta.generated).toBe("2026-09-30");
});

test("an invalid or missing cache falls back to the bundled snapshot", () => {
  expect(pickSnapshot(snap("2026-09-22"), { junk: true })._meta.generated).toBe("2026-09-22");
  expect(pickSnapshot(snap("2026-09-22"), undefined)._meta.generated).toBe("2026-09-22");
  expect(pickSnapshot(undefined, undefined)).toBeNull();
});

test("a cached older-schema snapshot loses even with a newer generated date", () => {
  // The 0.2.x → 0.3.0 case: a schema-1 v4-scored snapshot cached before the
  // SCHEMA_VERSION 2 bump must never win on `_meta.generated`.
  const schema1Cache = { ...snap("2026-09-28"), _meta: { schema: 1, generated: "2026-09-28" } };
  const picked = pickSnapshot(snap("2026-09-22"), schema1Cache);
  expect(picked._meta).toMatchObject({ schema: SCHEMA_VERSION, generated: "2026-09-22" });
});

// --- loadSnapshot ----------------------------------------------------------

test("loadSnapshot reads the fresher of the bundled file and the cache", () => {
  const bundledFile = path.join(dir, "bundled.json");
  fs.writeFileSync(bundledFile, JSON.stringify(snap("2026-09-22")));
  expect(loadSnapshot(bundledFile, dir)).toMatchObject({
    snapshot: { _meta: { generated: "2026-09-22" } },
    bundledCount: 2,
  });
  writeCache(snap("2026-09-28"));
  expect(loadSnapshot(bundledFile, dir).snapshot._meta.generated).toBe("2026-09-28");
});

test("loadSnapshot survives missing and corrupt files", () => {
  fs.writeFileSync(path.join(dir, "benchmarks.json"), "{not json");
  expect(loadSnapshot(path.join(dir, "nope.json"), dir)).toEqual({
    snapshot: null,
    bundledCount: 0,
  });
});

// --- shouldAttempt ---------------------------------------------------------

test("attempts when never checked", () => {
  expect(shouldAttempt({}, NOW)).toBe(true);
});

test("no attempt within a day of the last success", () => {
  expect(shouldAttempt({ lastSuccess: NOW - 23 * HOUR }, NOW)).toBe(false);
  expect(shouldAttempt({ lastSuccess: NOW - REFRESH_INTERVAL_MS }, NOW)).toBe(true);
});

test(`gives up for the day after ${MAX_FAILURES} failures`, () => {
  const windowStart = NOW - 5 * HOUR;
  expect(shouldAttempt({ failures: MAX_FAILURES - 1, windowStart }, NOW)).toBe(true);
  expect(shouldAttempt({ failures: MAX_FAILURES, windowStart }, NOW)).toBe(false);
  expect(shouldAttempt({ failures: MAX_FAILURES, windowStart: NOW - 25 * HOUR }, NOW)).toBe(true);
});

// --- refreshOnce -----------------------------------------------------------

test("a 200 with a valid snapshot is cached and the ETag remembered", async () => {
  const f = fakeFetch(200, snap("2026-09-29"), { etag: '"v1"' });
  const r = await run(f);
  expect(r).toEqual({ outcome: "cached", generated: "2026-09-29" });
  expect(
    JSON.parse(fs.readFileSync(path.join(dir, "benchmarks.json"), "utf8"))._meta.generated,
  ).toBe("2026-09-29");
  expect(readMeta()).toMatchObject({ etag: '"v1"', lastSuccess: NOW, failures: 0 });
});

test("the ETag is sent only while a valid cache exists", async () => {
  writeMeta({ etag: '"v1"' });
  const f = fakeFetch(200, snap("2026-09-29"));
  await run(f);
  expect(f.calls[0].init.headers?.["If-None-Match"]).toBeUndefined();

  writeCache(snap("2026-09-28"));
  writeMeta({ etag: '"v1"' });
  const g = fakeFetch(304);
  const r = await run(g);
  expect(g.calls[0].init.headers["If-None-Match"]).toBe('"v1"');
  expect(r.outcome).toBe("not-modified");
  expect(readMeta().lastSuccess).toBe(NOW);
});

test("skips the network entirely when not due", async () => {
  writeMeta({ lastSuccess: NOW - HOUR });
  const f = fakeFetch(200, snap("2026-09-29"));
  expect((await run(f)).outcome).toBe("skipped");
  expect(f.calls).toHaveLength(0);
});

test("a newer schema is reported, not cached, and its ETag not kept", async () => {
  const f = fakeFetch(200, snap("2026-09-29", { schema: SCHEMA_VERSION + 1 }), { etag: '"v2"' });
  const r = await run(f);
  expect(r).toEqual({ outcome: "schema-ahead", schema: SCHEMA_VERSION + 1 });
  expect(fs.existsSync(path.join(dir, "benchmarks.json"))).toBe(false);
  // Without a kept ETag the next daily check re-downloads and re-warns.
  expect(readMeta().etag).toBeUndefined();
  expect(readMeta()).toMatchObject({ lastSuccess: NOW, upstreamSchema: SCHEMA_VERSION + 1 });
});

test("a downloaded older-schema snapshot is rejected as a failure", async () => {
  // master serving schema 2 to this plugin is the normal case; the reverse —
  // an old schema-1 body reaching a schema-2 reader — must not be cached.
  const schema1 = { ...snap("2026-09-29"), _meta: { schema: 1, generated: "2026-09-29" } };
  const r = await run(fakeFetch(200, schema1));
  expect(r.outcome).toBe("failed");
  expect(fs.existsSync(path.join(dir, "benchmarks.json"))).toBe(false);
  expect(readMeta()).toMatchObject({ failures: 1, windowStart: NOW });
});

test("a known newer schema keeps being reported between daily checks, offline", async () => {
  writeMeta({ lastSuccess: NOW - HOUR, upstreamSchema: SCHEMA_VERSION + 1 });
  const f = fakeFetch(200, snap("2026-09-29"));
  expect(await run(f)).toEqual({ outcome: "schema-ahead", schema: SCHEMA_VERSION + 1 });
  expect(f.calls).toHaveLength(0);
});

test("a leftover upstreamSchema equal to the current version is skipped, not stuck", async () => {
  // A 0.2.x install (schema 1) that saw schema 2 as ahead recorded
  // upstreamSchema: 2; on this plugin 2 is current, so between daily checks it
  // must read as an ordinary skip, not keep reporting schema-ahead.
  writeMeta({ lastSuccess: NOW - HOUR, upstreamSchema: SCHEMA_VERSION });
  const f = fakeFetch(200, snap("2026-09-29"));
  expect(await run(f)).toEqual({ outcome: "skipped" });
  expect(f.calls).toHaveLength(0);
});

test("a readable snapshot clears a remembered newer schema", async () => {
  writeMeta({ lastSuccess: NOW - 25 * HOUR, upstreamSchema: SCHEMA_VERSION + 1 });
  await run(fakeFetch(200, snap("2026-09-29")));
  expect(readMeta().upstreamSchema).toBeUndefined();
});

test("garbage, HTTP errors and network errors count as failures", async () => {
  const bad = [
    fakeFetch(200, { models: 1 }),
    fakeFetch(500, {}),
    async () => {
      throw new Error("ENOTFOUND");
    },
  ];
  for (const [i, f] of bad.entries()) {
    expect((await run(f)).outcome).toBe("failed");
    expect(readMeta()).toMatchObject({ failures: i + 1, windowStart: NOW });
  }
  expect(fs.existsSync(path.join(dir, "benchmarks.json"))).toBe(false);
});

test("a suspiciously small snapshot is rejected", async () => {
  const r = await run(fakeFetch(200, snap("2026-09-29")), { minModels: 3 });
  expect(r.outcome).toBe("failed");
});

test("a hung request is aborted by the timeout", async () => {
  const hang = (_url, init) =>
    new Promise((_, reject) =>
      init.signal.addEventListener("abort", () => reject(init.signal.reason)),
    );
  const t0 = Date.now();
  const r = await run(hang, { timeoutMs: 50 });
  expect(r.outcome).toBe("failed");
  expect(Date.now() - t0).toBeLessThan(1000);
});

test("a failure window resets after a day", async () => {
  writeMeta({ failures: MAX_FAILURES, windowStart: NOW - 25 * HOUR });
  await run(fakeFetch(500, {}));
  expect(readMeta()).toMatchObject({ failures: 1, windowStart: NOW });
});

test("an unwritable cache dir never throws", async () => {
  const file = path.join(dir, "not-a-dir");
  fs.writeFileSync(file, "");
  const r = await refreshOnce({ fetch: fakeFetch(200, snap("2026-09-29")), dir: file, now: NOW });
  expect(r.outcome).toBe("failed");
});
