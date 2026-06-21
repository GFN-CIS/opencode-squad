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
 * Two facts verified on the live transform payload:
 *   1. `tokens.input` is the UNCACHED input only — the bulk of the context is in
 *      `cache.read`/`cache.write`. There is also a `total` field (absent from
 *      the SDK type) that sums everything. So prefer `total`, never `input`
 *      alone (which under-reports by orders of magnitude).
 *   2. A turn's recorded token count is HISTORICAL — after a compaction the
 *      context shrinks but the last completed turn still reports its old (huge)
 *      size for a turn, which made the signal cry "60%" right after a compact.
 *
 * Fix for (2): cross-check against the size of the actual outgoing payload
 * (`output.messages`, tool content included). If the live payload is far
 * smaller than the last recorded turn, a compaction happened — trust the
 * payload, not the stale count.
 *
 * @param {Array<{info?:{role?:string,modelID?:string,providerID?:string,tokens?:{total?:number,input?:number,output?:number,reasoning?:number,cache?:{read?:number,write?:number}}}, parts?:any[]}>} messages
 * @returns {{used:number, modelID?:string, providerID?:string}|null} null before any assistant reply
 */
export function estimateContextTokens(messages) {
  if (!Array.isArray(messages)) return null;
  let hist = 0;
  let modelID;
  let providerID;
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i]?.info;
    if (info?.role === "assistant" && info.tokens) {
      const t = info.tokens;
      const cache = t.cache || {};
      const v =
        typeof t.total === "number" && t.total > 0
          ? t.total
          : (t.input || 0) +
            (t.output || 0) +
            (t.reasoning || 0) +
            (cache.read || 0) +
            (cache.write || 0);
      if (v > 0) {
        hist = v;
        modelID = info.modelID;
        providerID = info.providerID;
        break;
      }
    }
  }

  if (hist <= 0) return null; // no completed turn yet → no usable signal

  // `crude` is a rough lower bound (it omits the system prompt / tool schemas
  // and undercounts vs real tokenization), so use it only as a coarse drop
  // detector, never as the reported number. If the live payload is a small
  // fraction (<25%) of the last recorded turn, a compaction just shrank the
  // context and `hist` is stale — suppress the line this turn rather than
  // crying "60%". The next completed turn reports the real (small) size.
  const crude = crudePayloadTokens(messages);
  if (crude > 0 && crude < hist * 0.25) return null;

  return { used: hist, modelID, providerID };
}

/**
 * Rough token estimate of the actual outgoing payload — sum of every part
 * serialized (tool I/O included, not just text), divided by ~4 chars/token.
 * Approximate by design: it only needs to tell ~5% from ~60% (a 12x gap),
 * and unlike a per-turn token count it can never go stale across a compaction.
 *
 * @param {Array<{parts?:any[]}>} messages
 * @returns {number}
 */
export function crudePayloadTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const m of messages) {
    for (const p of m?.parts || []) {
      try {
        chars += JSON.stringify(p).length;
      } catch {
        // skip unserializable parts
      }
    }
  }
  return Math.round(chars / 4);
}

/**
 * Resolve the orchestrator's actual model from the latest assistant turn
 * (exact), as `providerID/modelID`. Null on the first turn (no assistant yet),
 * where the caller falls back to the configured agent model.
 *
 * @param {Array<{info?:{role?:string,modelID?:string,providerID?:string}}>} messages
 * @returns {string|null}
 */
export function resolveOrchestratorModel(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i]?.info;
    if (info?.role === "assistant" && info.modelID) {
      return info.providerID ? `${info.providerID}/${info.modelID}` : info.modelID;
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

const k = (n) => `${Math.round(n / 1000)}k`;

// Nudge only when the context is genuinely close to full. Keyed on remaining
// headroom, not a flat percentage: 50% of a 1M window is ~500k free — nothing
// to worry about (opencode auto-compacts before then), so a flat ">50%" cried
// wolf on big windows. Trigger when free space drops below ~25% of the window,
// capped at 150k so small windows aren't nagged too early.
export const HEADROOM_FLOOR = 150_000;

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
  const remaining = lim ? lim - used : null;
  const heavy =
    remaining != null && remaining < Math.min(HEADROOM_FLOOR, lim * 0.25);
  const nudge = heavy
    ? ` Only ~${k(remaining)} of headroom left — prefer delegating heavy-I/O work and keep this context for orchestration.`
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
