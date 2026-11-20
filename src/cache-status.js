// Prompt-cache TTL per provider, for the squad_session report
// (src/session-status.js): whether a subagent session's cache is still warm
// decides whether reusing that session is worth it.
//
// TTL numbers come from the hand-editable `cache_ttl_seconds` field in
// model_data.json (same file/pattern as `info` and `billing` — see
// src/model-data.js), because published TTLs vary by provider and some
// (alibaba-token-plan, zai-coding-plan, as of 2026-08) don't publish one at
// all.
//
// When that field is absent, `resolveCacheTtl()` below supplies a number
// anyway. That fallback lives here, on the read path of every squad_session
// call, rather than in a manual script that writes the field: a script nobody
// runs leaves the field unset exactly as it was before.
//
// Every provider gets a TTL, because the previous behaviour — "TTL isn't
// published, judge for yourself" — was read as "no constraint", i.e. as if the
// cache lived forever. A conservative floor is a better prior than silence.
// What stays honest is the LABEL: a published TTL is reported as published, an
// assumed one says so and names the floor, so the orchestrator can tell a fact
// from a default.

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
  /** @param {Record<string, number>} table */
  const at = (table) =>
    providerID && Object.hasOwn(table, providerID) ? table[providerID] : undefined;

  const published = at(PUBLISHED_CACHE_TTL_SECONDS);
  if (typeof published === "number") return { seconds: published, source: "published" };
  const measured = at(MEASURED_CACHE_TTL_SECONDS);
  if (typeof measured === "number") return { seconds: measured, source: "measured" };
  return { seconds: ASSUMED_CACHE_TTL_SECONDS, source: "assumed" };
}
