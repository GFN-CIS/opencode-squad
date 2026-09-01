// Pure formatting for the [CACHE STATUS] note appended to a completed task's
// result (see the `tool.execute.after` hook on "task" in the plugin).
//
// Goal: when a `task` tool call finishes, tell the orchestrator how long ago
// that subagent session last actually hit its provider, and whether that's
// still inside the provider's prompt-cache TTL — so it can decide whether
// passing this session's task_id back in (to reuse the cache) is still worth
// it, or whether the cache has gone cold and a fresh session is no better.
//
// TTL numbers come from the hand-editable `cache_ttl_seconds` field in
// model_data.json (same file/pattern as `info` and `billing` — see
// src/model-data.js), because published TTLs vary by provider and some
// (alibaba-token-plan, zai-coding-plan, as of 2026-08) don't publish one at
// all.
//
// When that field is absent, `resolveCacheTtl()` below supplies a number
// anyway. That fallback lives here (read on every completed `task` call)
// rather than in scripts/squad-file-performance.mjs, which is manual-only by
// design and so would leave the field unset exactly as it was before.
//
// Every provider gets a TTL, because the previous behaviour — "TTL isn't
// published, judge for yourself" — was read as "no constraint", i.e. as if the
// cache lived forever. A conservative floor is a better prior than silence.
// What stays honest is the LABEL: a published TTL is reported as published, an
// assumed one says so and names the floor, so the orchestrator can tell a fact
// from a default.

function humanizeSeconds(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

// Published prompt-cache TTLs, keyed by opencode providerID. Consulted only
// when model_data.json carries no `cache_ttl_seconds` for the model.
//
// anthropic: 300s (5 min, refreshed on hit; a paid 1h option exists but is not
//   what these sessions use — empirically confirmed on ses_fbd96c79: a 3m45s
//   gap came back warm, the shortest cold gap observed was 7m36s).
// openai: 1800s (30 min, gpt-5.6+).
const PUBLISHED_CACHE_TTL_SECONDS = {
  anthropic: 300,
  openai: 1800,
};

// Measured TTLs for providers that publish nothing, derived from opencode's own
// message history by scripts/squad-measure-cache-ttl.mjs (see
// src/cache-ttl-measure.js for the method — it reproduces Anthropic's published
// 300s from ~70k samples, which is what makes it trustworthy here).
//
// Consulted only below the published table: a vendor's own number wins over our
// regression of it. Measured as of 2026-09-01:
//   zai              600 — 95% hits under 5m, still 93% at 5-10m, 83% at 10-20m
//   zai-coding-plan  600 — 98% under 5m, 81% at 5-10m, 50% at 10-20m
//   github-copilot   300 — 92% under 5m, then flat zero in every later bucket
//
// The two 600s rest on thin decisive buckets (n=15 and n=16) and are rounded
// DOWN to the last gap with real evidence rather than up to where the curve
// finally dies — same err-toward-cold bias as the floor below. What they buy is
// not precision: it's not telling the orchestrator a 6-minute-old zai session is
// cold when ~85% of them are still warm.
//
// Deliberately absent: alibaba-token-plan (points the same way but rests on 5
// sessions total), and google (no sample anywhere past 5m, so "300" would mean
// "never observed", not "measured"). Both keep the floor until there's data.
const MEASURED_CACHE_TTL_SECONDS = {
  zai: 600,
  "zai-coding-plan": 600,
  "github-copilot": 300,
};

// Assumed TTL for providers with neither a published nor a measured figure.
// 300s is the shortest TTL anyone publishes,
// so it errs toward "cold" — the cheap direction: a false "cold" costs one
// re-brief, a false "warm" costs a full context re-upload.
//
// Deliberately NOT applied on top of the published table: a flat 300 for
// everyone would report a genuinely warm 30-min OpenAI session as cold.
export const ASSUMED_CACHE_TTL_SECONDS = 300;

/**
 * Resolve a prompt-cache TTL for a provider, always returning a number, with
 * `source` marking where it came from. Callers surface that distinction rather
 * than passing a bare number off as fact.
 *
 * Tiers, most authoritative first: published by the vendor, measured from our
 * own history, then the assumed floor.
 *
 * @param {string} [providerID]  opencode providerID, e.g. "anthropic"
 * @returns {{seconds:number, source:"published"|"measured"|"assumed"}}
 */
export function resolveCacheTtl(providerID) {
  // Own-property check: a bare `[providerID]` lookup would resolve
  // "constructor"/"toString" to Object.prototype members.
  const at = (table) =>
    providerID && Object.hasOwn(table, providerID) ? table[providerID] : undefined;

  const published = at(PUBLISHED_CACHE_TTL_SECONDS);
  if (typeof published === "number") return { seconds: published, source: "published" };
  const measured = at(MEASURED_CACHE_TTL_SECONDS);
  if (typeof measured === "number") return { seconds: measured, source: "measured" };
  return { seconds: ASSUMED_CACHE_TTL_SECONDS, source: "assumed" };
}

const k = (n) => `${Math.round(n / 1000)}k`;

/**
 * Render the size clause: how big the session being offered for reuse actually
 * is. Reuse re-reads all of it on every single step, which is the cost the
 * orchestrator was previously blind to — it only ever saw warm/cold.
 *
 * Carries `estimateContextTokens`'s caveat: the figure is the last COMPLETED
 * turn, so immediately after a compaction it still reads high for one turn.
 * Saying so matters most in exactly the compact-then-continue flow this
 * number exists to enable.
 *
 * @param {number} [contextTokens]
 * @param {number} [contextLimit]
 * @returns {string}  "" when there's nothing trustworthy to report
 */
function formatSizeClause(contextTokens, contextLimit) {
  if (typeof contextTokens !== "number" || contextTokens <= 0) return "";
  const pct =
    typeof contextLimit === "number" && contextLimit > 0
      ? ` / ${k(contextLimit)} (${Math.round((contextTokens / contextLimit) * 100)}%)`
      : "";
  return (
    ` Its context is ~${k(contextTokens)}${pct} as of its last completed turn ` +
    `(so right after a compaction this still reads high for one turn). ` +
    `Reusing it re-reads all of that on every step; a fresh session starts from the brief.`
  );
}

/**
 * @param {{
 *   taskId: string,
 *   providerModelId: string,
 *   lastHitMs: number,
 *   lastHitAtText?: string,
 *   ttlSeconds?: number,
 *   ttlSource?: "published"|"measured"|"assumed",
 *   contextTokens?: number,
 *   contextLimit?: number,
 *   now: number,
 * }} info
 * @returns {string}
 */
export function formatCacheStatus(info) {
  const ageSeconds = Math.max(0, (info.now - info.lastHitMs) / 1000);
  // Both forms on purpose: the relative age is what reads at the moment the
  // task finishes, the absolute wall-clock is what's still usable a turn later
  // — the orchestrator has to recompute the gap against its own bootstrap
  // "now" when it decides whether to reuse this session, and "~17m ago" is
  // meaningless by then. Same format/zone as the bootstrap's clock so the two
  // are directly comparable. Degrades to relative-only if unformattable.
  const ageStr = info.lastHitAtText
    ? `~${humanizeSeconds(ageSeconds)} ago (${info.lastHitAtText})`
    : `~${humanizeSeconds(ageSeconds)} ago`;

  const ttl =
    typeof info.ttlSeconds === "number"
      ? { seconds: info.ttlSeconds, source: info.ttlSource ?? "published" }
      : resolveCacheTtl(info.providerModelId?.split("/")[0]);

  const verdict = ageSeconds < ttl.seconds ? "likely still warm" : "likely cold by now";
  const ttlLine = {
    published: () => `published cache TTL ~${humanizeSeconds(ttl.seconds)} — ${verdict}`,
    measured: () =>
      `this provider publishes no TTL; ~${humanizeSeconds(ttl.seconds)} measured from ` +
      `our own history — ${verdict}`,
    assumed: () =>
      `no cache TTL published for this provider, assuming a conservative ` +
      `~${humanizeSeconds(ttl.seconds)} floor — ${verdict}`,
  }[ttl.source]();

  return (
    `[CACHE STATUS] task_id=${info.taskId} — last provider hit ${ageStr}, model ${info.providerModelId}. ` +
    `${ttlLine}.${formatSizeClause(info.contextTokens, info.contextLimit)} ` +
    `Pass task_id to continue this same session if you want to reuse it.`
  );
}
