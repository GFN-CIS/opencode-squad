// Derive a provider's prompt-cache TTL from opencode's own message history,
// instead of taking a published number on faith (or having none at all).
//
// The signal: every provider opencode talks to reports `tokens.cache.read`, so
// for two consecutive assistant messages on the SAME provider+model we can ask
// "did the later one hit the prefix cache?" and correlate that against the gap
// between them. Bucket by gap, and the TTL shows up as the point where the hit
// rate falls off.
//
// Validated against Anthropic, whose 300s TTL is published: the curve comes out
// 93% under 5m / 7% at 5-10m / ~2% beyond, across ~70k samples. Recovering a
// known ground truth is what makes the same method trustworthy for providers
// that publish nothing (zai, zai-coding-plan, github-copilot, alibaba).
//
// This is IO-free on purpose — scripts/squad-measure-cache-ttl.mjs does the
// sqlite reading and hands the rows in.

// A sample counts as a cache hit when the later message re-read more than half
// the prefix the earlier one had accumulated. Not a tuning knob: the observed
// distribution is sharply bimodal — ratios cluster around 0.97 (full prefix
// hit) or 0.03 (nothing), with essentially nothing in between — so any
// separator in the middle gives the same answer. 0.5 is the obvious one.
export const HIT_RATIO_THRESHOLD = 0.5;

// A prefix has to be worth caching before its absence means anything; below
// this, providers may skip caching entirely and a "miss" says nothing about TTL.
export const MIN_PREFIX_TOKENS = 2000;

// Gap buckets, in seconds. Boundaries are placed on the TTLs actually in play
// (300s Anthropic, 1800s OpenAI) so a cliff lands on an edge rather than being
// smeared across one.
const DEFAULT_BUCKETS = [
  [0, 300],
  [300, 600],
  [600, 1200],
  [1200, 1800],
  [1800, 3600],
  [3600, 7200],
  [7200, 21600],
  [21600, Number.POSITIVE_INFINITY],
];

/**
 * Turn one session's ordered assistant messages into gap/hit samples.
 *
 * Pairs are skipped when they can't speak to TTL:
 *   - a model or provider switch between the two (the cache could never hit);
 *   - a compaction turn (`summary`), which deliberately rewrites the prefix;
 *   - too small a prefix to be cached at all;
 *   - a negative gap (clock skew / out-of-order rows).
 *
 * @param {Array<{time:number, total:number, cacheRead:number, providerID?:string, modelID?:string, summary?:boolean}>} messages
 *   assistant messages, ordered oldest-first
 * @param {string} [sessionID]  carried through so callers can count distinct sessions
 * @returns {Array<{gapSeconds:number, ratio:number, hit:boolean, providerID:string, modelID:string, sessionID?:string}>}
 */
export function collectSamples(messages, sessionID) {
  const out = [];
  if (!Array.isArray(messages)) return out;
  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1];
    const cur = messages[i];
    if (!prev || !cur) continue;
    if (cur.summary) continue;
    if (!cur.providerID || prev.providerID !== cur.providerID) continue;
    if (prev.modelID !== cur.modelID) continue;
    const total = prev.total || 0;
    if (total < MIN_PREFIX_TOKENS) continue;
    const gapSeconds = (cur.time - prev.time) / 1000;
    if (!(gapSeconds >= 0)) continue;
    const ratio = (cur.cacheRead || 0) / total;
    out.push({
      gapSeconds,
      ratio,
      hit: ratio > HIT_RATIO_THRESHOLD,
      providerID: cur.providerID,
      modelID: cur.modelID ?? "?",
      sessionID,
    });
  }
  return out;
}

/**
 * Group samples into gap buckets with hit rates.
 *
 * `n` travels with every row on purpose: a bucket reading 100% on two samples
 * next to one reading 93% on sixty thousand is actively misleading without it.
 *
 * @param {Array<{gapSeconds:number, hit:boolean, sessionID?:string}>} samples
 * @param {Array<[number, number]>} [buckets]
 * @returns {Array<{lo:number, hi:number, n:number, sessions:number, hitRate:number}>}
 */
export function bucketize(samples, buckets = DEFAULT_BUCKETS) {
  const rows = [];
  for (const [lo, hi] of buckets) {
    const sel = samples.filter((s) => s.gapSeconds >= lo && s.gapSeconds < hi);
    if (sel.length === 0) continue;
    rows.push({
      lo,
      hi,
      n: sel.length,
      sessions: new Set(sel.map((s) => s.sessionID)).size,
      hitRate: sel.filter((s) => s.hit).length / sel.length,
    });
  }
  return rows;
}

/**
 * Read a TTL off the bucketed curve.
 *
 * Walks buckets from the shortest gap upward and keeps extending the TTL for as
 * long as a bucket is both well-populated and still mostly hitting. It stops at
 * the first bucket that fails either test, and the answer is that bucket's lower
 * edge — i.e. the last gap we have evidence the cache survives.
 *
 * Deliberately never extrapolates past observed data: running out of samples
 * stops the walk exactly like a miss does, and `reason` says which happened, so
 * a thin tail can't inflate the number.
 *
 * @param {Array<{lo:number, hi:number, n:number, hitRate:number}>} rows  from bucketize()
 * @param {{minSamples?:number, minHitRate?:number}} [opts]
 * @returns {{ttlSeconds:number|null, reason:string, confidence:"none"|"weak"|"ok"}}
 */
export function deriveTtl(rows, opts = {}) {
  const minSamples = opts.minSamples ?? 10;
  const minHitRate = opts.minHitRate ?? 0.5;
  if (!rows.length) return { ttlSeconds: null, reason: "no samples", confidence: "none" };

  let ttl = null;
  let reason = "";
  let thinnest = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    if (row.n < minSamples) {
      reason = ttl
        ? `only ${row.n} sample(s) past ${ttl}s — not enough to say it survives longer`
        : `only ${row.n} sample(s) at any gap — nothing measurable`;
      break;
    }
    if (row.hitRate < minHitRate) {
      reason = `hit rate falls to ${Math.round(row.hitRate * 100)}% (n=${row.n}) past ${row.lo}s`;
      break;
    }
    thinnest = Math.min(thinnest, row.n);
    ttl = Number.isFinite(row.hi) ? row.hi : row.lo;
    reason = `still ${Math.round(row.hitRate * 100)}% hits (n=${row.n}) out to ${ttl}s`;
  }

  if (ttl === null) return { ttlSeconds: null, reason, confidence: "none" };
  // "ok" means the decisive bucket wasn't carried by a handful of samples.
  return { ttlSeconds: ttl, reason, confidence: thinnest >= 30 ? "ok" : "weak" };
}

const humanGap = (s) => (Number.isFinite(s) ? `${Math.round(s / 60)}m` : "∞");

/**
 * Render one provider's curve and verdict as text.
 *
 * @param {string} providerID
 * @param {Array<{lo:number, hi:number, n:number, sessions:number, hitRate:number}>} rows
 * @param {{ttlSeconds:number|null, reason:string, confidence:string}} verdict
 * @returns {string}
 */
export function formatProviderReport(providerID, rows, verdict) {
  const lines = [`### ${providerID}`];
  for (const r of rows) {
    const label = `${humanGap(r.lo)}-${humanGap(r.hi)}`.padStart(9);
    lines.push(
      `  ${label}  n=${String(r.n).padEnd(6)} sessions=${String(r.sessions).padEnd(4)} ` +
        `hit=${String(Math.round(r.hitRate * 100)).padStart(3)}%`,
    );
  }
  lines.push(
    verdict.ttlSeconds === null
      ? `  -> no measurable TTL (${verdict.reason})`
      : `  -> cache_ttl_seconds ≈ ${verdict.ttlSeconds} [${verdict.confidence}] — ${verdict.reason}`,
  );
  return lines.join("\n");
}
