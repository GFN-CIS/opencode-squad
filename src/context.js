// Context-size and model-limit helpers: a session's current size from its
// last assistant message's token usage (squad_session, squad_compact), and the
// context windows / reasoning variants opencode resolves per model.

/**
 * Estimate the orchestrator's current context size from message history.
 *
 * `tokens.input` is the UNCACHED input only — the bulk of the context is in
 * `cache.read`/`cache.write`. There is also a `total` field (absent from the
 * SDK type) that sums everything. So prefer `total`, never `input` alone (which
 * under-reports by orders of magnitude). This reflects the last *completed*
 * turn, so right after a compaction it reads high for one turn until the next
 * turn records the shrunk size — the formatted line says so, and the
 * orchestrator judges accordingly (no thresholds here).
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
      if (used > 0) {
        return { used, modelID: info.modelID, providerID: info.providerID };
      }
    }
  }
  return null;
}

/**
 * Format a Date as `YYYY-MM-DD HH:mm:ss (TimeZone)` in the given IANA zone.
 * sv-SE gives an ISO-like, locale-stable rendering. Returns null if formatting
 * is unavailable.
 *
 * @param {Date} date
 * @param {string} [timeZone] IANA zone, e.g. "Europe/Moscow"
 * @returns {string|null}
 */
export function formatLocalDateTime(date, timeZone) {
  try {
    const s = new Intl.DateTimeFormat("sv-SE", {
      dateStyle: "short",
      timeStyle: "medium",
      timeZone,
    }).format(date);
    return timeZone ? `${s} (${timeZone})` : s;
  } catch {
    return null;
  }
}

/**
 * A context window or size for display: `200k`, `1M`, `1.5M`.
 *
 * @param {number} n tokens
 * @returns {string}
 */
export const formatContextSize = (n) =>
  n >= 1_000_000 ? `${Math.round(n / 1e5) / 10}M` : `${Math.round(n / 1000)}k`;

/**
 * A token count in whole thousands, `42k` — even past a million, so a before /
 * after pair reads on one scale.
 *
 * @param {number} n tokens
 * @returns {string}
 */
export const formatThousands = (n) => `${Math.round(n / 1000)}k`;

/**
 * Build a {modelID/providerID -> context window} lookup from the resolved
 * normalized provider list, keyed both as
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
    const pid = p?.id;
    const models = p?.models;
    if (!pid || !models || typeof models !== "object") continue;
    for (const [mid, m] of Object.entries(models)) {
      const ctx = m?.limit?.context;
      if (typeof ctx === "number" && ctx > 0) {
        map[`${pid}/${mid}`] = ctx;
        if (!(mid in map)) map[mid] = ctx;
      }
    }
  }
  return map;
}

/**
 * `providerID/modelID` -> the reasoning variant names opencode will actually
 * accept for that model.
 *
 * Read from opencode's own provider list rather than derived from models.dev,
 * because deriving it is a trap. opencode builds a model's variants from
 * `reasoning_options` by TYPE, and each type produces different names: `effort`
 * yields the published values verbatim, `budget_tokens` yields `high`/`max`
 * (but only for providers that have a budget parameter — openai-compatible does
 * not, so those get nothing), and `toggle` yields `none`/`high` for exactly two
 * npm packages. Observed consequence: `claude-haiku-4-5` publishes only
 * `[{type: "budget_tokens", min: 1024}]`, so reading the effort values gives
 * "no variants" while opencode in fact accepts `high` and `max`.
 *
 * Getting it wrong is silent — opencode drops an unrecognized variant without
 * erroring — which is exactly why this comes from the horse's mouth.
 *
 * @param {Array<{id?:string, models?:Record<string, {variants?:unknown}>}>} providers
 * @returns {Record<string, string[]>}
 */
export function buildVariantMap(providers) {
  /** @type {Record<string, string[]>} */
  const map = {};
  if (!Array.isArray(providers)) return map;
  for (const p of providers) {
    const pid = p?.id;
    const models = p?.models;
    if (!pid || !models || typeof models !== "object") continue;
    for (const [mid, m] of Object.entries(models)) {
      const v = m?.variants;
      // Both shapes seen in the wild: a keyed object of settings, or a list.
      const names = Array.isArray(v)
        ? v.filter((x) => typeof x === "string")
        : v && typeof v === "object"
          ? Object.keys(v)
          : [];
      map[`${pid}/${mid}`] = names;
    }
  }
  return map;
}
