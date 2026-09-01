import { expect, test } from "vitest";
import {
  bucketize,
  collectSamples,
  deriveTtl,
  formatProviderReport,
  HIT_RATIO_THRESHOLD,
  MIN_PREFIX_TOKENS,
} from "../src/cache-ttl-measure.js";

const msg = (over = {}) => ({
  time: 0,
  total: 100_000,
  cacheRead: 0,
  providerID: "anthropic",
  modelID: "claude-opus-5",
  summary: false,
  ...over,
});

const S = 1000; // ms per second

test("collectSamples turns consecutive messages into gap/hit samples", () => {
  const out = collectSamples(
    [
      msg({ time: 0 }),
      msg({ time: 60 * S, cacheRead: 98_000 }), // full prefix hit
      msg({ time: 600 * S, cacheRead: 1_000 }), // miss
    ],
    "ses_x",
  );
  expect(out).toHaveLength(2);
  expect(out[0]).toMatchObject({ gapSeconds: 60, hit: true, sessionID: "ses_x" });
  expect(out[1]).toMatchObject({ gapSeconds: 540, hit: false });
});

test("collectSamples skips pairs that could never speak to TTL", () => {
  // A model or provider switch means the cache had nothing to hit; a compaction
  // turn rewrites the prefix on purpose; a tiny prefix may not be cached at all.
  const cases = {
    "model switch": [msg({ time: 0 }), msg({ time: 60 * S, modelID: "claude-sonnet-5" })],
    "provider switch": [msg({ time: 0 }), msg({ time: 60 * S, providerID: "openai" })],
    compaction: [msg({ time: 0 }), msg({ time: 60 * S, summary: true })],
    "prefix too small": [
      msg({ time: 0, total: MIN_PREFIX_TOKENS - 1 }),
      msg({ time: 60 * S, cacheRead: 900 }),
    ],
    "negative gap": [msg({ time: 60 * S }), msg({ time: 0 })],
    "missing provider": [msg({ time: 0 }), msg({ time: 60 * S, providerID: undefined })],
  };
  for (const [name, messages] of Object.entries(cases)) {
    expect(collectSamples(messages), name).toHaveLength(0);
  }
});

test("collectSamples tolerates junk input instead of throwing", () => {
  expect(collectSamples(null)).toEqual([]);
  expect(collectSamples([])).toEqual([]);
  expect(collectSamples([msg()])).toEqual([]); // one message = no pair
});

test("the hit threshold sits between the two observed clusters", () => {
  // Real ratios cluster near 0.97 or near 0.03; the separator only has to land
  // in the empty middle.
  expect(HIT_RATIO_THRESHOLD).toBeGreaterThan(0.03);
  expect(HIT_RATIO_THRESHOLD).toBeLessThan(0.97);
});

test("bucketize reports n and session count alongside the rate", () => {
  const samples = [
    { gapSeconds: 10, hit: true, sessionID: "a" },
    { gapSeconds: 20, hit: true, sessionID: "a" },
    { gapSeconds: 30, hit: false, sessionID: "b" },
    { gapSeconds: 400, hit: false, sessionID: "c" },
  ];
  const rows = bucketize(samples);
  expect(rows[0]).toMatchObject({ lo: 0, hi: 300, n: 3, sessions: 2 });
  expect(rows[0].hitRate).toBeCloseTo(2 / 3);
  expect(rows[1]).toMatchObject({ lo: 300, hi: 600, n: 1, sessions: 1, hitRate: 0 });
  // Empty buckets are dropped, not rendered as 0%.
  expect(rows).toHaveLength(2);
});

test("deriveTtl finds the cliff — the Anthropic shape it was validated against", () => {
  const rows = [
    { lo: 0, hi: 300, n: 67_203, hitRate: 0.93 },
    { lo: 300, hi: 600, n: 1053, hitRate: 0.07 },
    { lo: 600, hi: 1200, n: 609, hitRate: 0.02 },
  ];
  const v = deriveTtl(rows);
  expect(v.ttlSeconds).toBe(300); // the published figure, recovered from data
  expect(v.confidence).toBe("ok");
  expect(v.reason).toContain("7%");
});

test("deriveTtl extends past the first bucket while the cache keeps hitting", () => {
  const rows = [
    { lo: 0, hi: 300, n: 2822, hitRate: 0.98 },
    { lo: 300, hi: 600, n: 16, hitRate: 0.81 },
    { lo: 600, hi: 1200, n: 4, hitRate: 0.5 },
  ];
  const v = deriveTtl(rows);
  expect(v.ttlSeconds).toBe(600);
  // Decided by a 16-sample bucket — must not read as solid.
  expect(v.confidence).toBe("weak");
  expect(v.reason).toContain("only 4 sample(s)");
});

test("deriveTtl never extrapolates past the data it has", () => {
  // One well-populated bucket and nothing beyond: the answer is "at least this",
  // never a guess about what happens later.
  const v = deriveTtl([{ lo: 0, hi: 300, n: 1121, hitRate: 0.97 }]);
  expect(v.ttlSeconds).toBe(300);
  expect(v.reason).toContain("out to 300s");
});

test("deriveTtl reports no TTL when the very first bucket is unusable", () => {
  expect(deriveTtl([])).toMatchObject({ ttlSeconds: null, confidence: "none" });
  expect(deriveTtl([{ lo: 0, hi: 300, n: 3, hitRate: 1 }])).toMatchObject({
    ttlSeconds: null,
    confidence: "none",
  });
  const cold = deriveTtl([{ lo: 0, hi: 300, n: 500, hitRate: 0.1 }]);
  expect(cold.ttlSeconds).toBeNull();
  expect(cold.reason).toContain("falls to 10%");
});

test("deriveTtl uses the lower edge of an unbounded final bucket", () => {
  const v = deriveTtl([
    { lo: 0, hi: 300, n: 100, hitRate: 0.9 },
    { lo: 300, hi: Number.POSITIVE_INFINITY, n: 100, hitRate: 0.9 },
  ]);
  expect(v.ttlSeconds).toBe(300); // not Infinity
});

test("formatProviderReport always prints n next to the rate", () => {
  const rows = [{ lo: 0, hi: 300, n: 2, sessions: 1, hitRate: 1 }];
  const text = formatProviderReport("zai", rows, deriveTtl(rows));
  expect(text).toContain("### zai");
  expect(text).toContain("n=2");
  expect(text).toContain("hit=100%");
  // A 2-sample bucket must not yield a confident-looking number.
  expect(text).toContain("no measurable TTL");
});
