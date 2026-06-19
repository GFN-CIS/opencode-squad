// Live context-budget signal for the orchestrator.
//
// Delegation offloads raw reading / long tool output / iteration into the
// subagent's own session; the orchestrator only pays for (brief + compact
// result). The bigger the orchestrator's context already is, the more that
// trade favours delegating. This module turns the last assistant message's
// token usage into a short line injected each turn.

export const CONTEXT_MARKER = "<ORCHESTRATE_CONTEXT>";

// Fallback window when the model's limit is unknown (conservative: a smaller
// window over-reports the percentage, which only nudges delegation earlier).
export const DEFAULT_LIMIT = 200_000;

/**
 * Estimate the orchestrator's current context size from message history.
 *
 * IMPORTANT (verified on the live transform payload): opencode's `tokens.input`
 * is the UNCACHED input only — the bulk of the context lives in
 * `cache.read`/`cache.write`. The runtime payload also carries a `total` field
 * (absent from the SDK type) that already sums everything. So prefer `total`,
 * and fall back to input + output + reasoning + cache.read + cache.write —
 * never `input` alone, which under-reports by orders of magnitude.
 *
 * @param {Array<{info?:{role?:string,modelID?:string,providerID?:string,tokens?:{total?:number,input?:number,output?:number,reasoning?:number,cache?:{read?:number,write?:number}}}}>} messages
 * @returns {{used:number, modelID?:string, providerID?:string}|null} null before any assistant reply
 */
export function estimateContextTokens(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i]?.info;
    if (info?.role === "assistant" && info.tokens) {
      const t = info.tokens;
      const cache = t.cache || {};
      const used =
        typeof t.total === "number" && t.total > 0
          ? t.total
          : (t.input || 0) +
            (t.output || 0) +
            (t.reasoning || 0) +
            (cache.read || 0) +
            (cache.write || 0);
      if (used <= 0) return null;
      return { used, modelID: info.modelID, providerID: info.providerID };
    }
  }
  return null;
}

const k = (n) => `${Math.round(n / 1000)}k`;

/**
 * Render the context-budget line. Returns null when there is nothing useful to
 * say (no usage yet).
 *
 * @param {number|null} used
 * @param {number|null} [limit]
 * @returns {string|null}
 */
export function formatContextLine(used, limit) {
  if (used == null || used <= 0) return null;
  const lim = limit && limit > 0 ? limit : null;
  const pct = lim ? Math.round((used / lim) * 100) : null;
  const size = lim ? `~${k(used)} / ${k(lim)} (${pct}%)` : `~${k(used)} tokens`;
  const heavy = pct != null && pct >= 50;
  const nudge = heavy
    ? ` You are past ${pct}% — PREFER delegating any heavy-I/O task and keep this context for orchestration.`
    : "";
  return (
    `${CONTEXT_MARKER}\n` +
    `Your current context: ${size}.${nudge} ` +
    `Weigh it in the verdict: doing it yourself burns the raw reading and ` +
    `iterations into THIS context, while delegating costs you only the brief ` +
    `plus a compact result.\n` +
    `</ORCHESTRATE_CONTEXT>`
  );
}

/**
 * Build a {modelID/providerID -> context window} lookup from the resolved
 * provider list (`client.config.providers()` → `data.providers`), keyed both as
 * `providerID/modelID` and bare `modelID`. Using the resolved list (not raw
 * user config) is what makes built-in models like opus-4-7 (1M) resolve to
 * their real window instead of the fallback.
 *
 * @param {Array<{id?:string, models?:Record<string,{limit?:{context?:number}}>}>} providers
 * @returns {Record<string, number>}
 */
export function buildLimitMap(providers) {
  /** @type {Record<string, number>} */
  const map = {};
  if (!Array.isArray(providers)) return map;
  for (const p of providers) {
    const pid = p && p.id;
    const models = p && p.models;
    if (!pid || !models || typeof models !== "object") continue;
    for (const [mid, m] of Object.entries(models)) {
      const ctx = m && m.limit && m.limit.context;
      if (typeof ctx === "number" && ctx > 0) {
        map[`${pid}/${mid}`] = ctx;
        if (!(mid in map)) map[mid] = ctx;
      }
    }
  }
  return map;
}
