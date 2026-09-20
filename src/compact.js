// Compacting a SUBAGENT session on demand — the decision inputs and the report,
// kept pure so the plugin tool is just plumbing.
//
// WHY. Reuse of a subagent session is all-or-nothing today: pass the task_id and
// the whole history is re-read on every step, or start fresh and throw the
// history away. The middle option exists in opencode and nothing was reaching
// for it — `POST /session/{id}/summarize` runs the same compaction the prompt
// loop runs on overflow (`compaction.create({auto:false})` + a prompt loop),
// and it takes any session id, a subagent's included.
//
// The orchestrator's case is exactly the one auto-compaction does not cover:
// auto only fires at the context LIMIT (`usable = model.limit.input - reserved`,
// so ~1M on sonnet-5 — a 596k grunt session never qualified), while the useful
// moment is far earlier, when sarge is about to send a long NEW task down a
// session whose context is large and mostly irrelevant to it.
//
// WHAT IT COSTS, because this is not free and the tool must say so:
//   - one full pass of the compacting model over the history (input priced at
//     the whole context, output the summary);
//   - the session's prompt prefix changes, so its provider cache goes COLD —
//     the next request re-uploads the compacted context.
// It pays off when many turns follow. For one short dispatch, a fresh session
// is cheaper.

/** Cheap-first ordering: a flat-rate subscription model has ~$0 marginal cost. */
const SUBSCRIPTION = "subscription";

/**
 * Pick the model that will WRITE the summary.
 *
 * Summarising is mechanical next to the work the session did, so the default
 * deliberately does not reuse the session's own (often expensive) model: it
 * takes the cheapest model the squad actually has an agent for, preferring a
 * flat-rate one. The session model is the last resort, not the first choice —
 * an opus grunt re-reading 600k of its own history to write a summary is the
 * exact bill this feature exists to avoid.
 *
 * @param {object} input
 * @param {string} [input.explicit]  caller-supplied `provider/model`, wins outright
 * @param {Record<string, {price_blended?: number|null, billing?: string}>} [input.models]
 *   model_data.json `models` map, keyed by `provider/model`
 * @param {Set<string>|string[]} [input.available]  model ids that have an agent
 * @param {string} [input.sessionModel]  `provider/model` of the session itself
 * @returns {{id: string, why: string} | null}
 */
export function pickCompactionModel({ explicit, models, available, sessionModel } = {}) {
  const parse = (id) => {
    const s = String(id ?? "").trim();
    const at = s.indexOf("/");
    return at > 0 && at < s.length - 1 ? s : null;
  };

  const chosen = parse(explicit);
  if (chosen) return { id: chosen, why: "explicitly requested" };

  const pool = available instanceof Set ? available : new Set(available ?? []);
  const entries = Object.entries(models ?? {}).filter(([id]) => pool.size === 0 || pool.has(id));

  const subscription = entries.filter(([, m]) => m?.billing === SUBSCRIPTION);
  if (subscription.length > 0) {
    // Among flat-rate models the price field says nothing about what this call
    // costs, so pick deterministically by id rather than pretending to rank.
    const id = subscription.map(([id]) => id).sort()[0];
    return { id, why: "flat-rate (subscription) — ~$0 marginal cost for the pass" };
  }

  const priced = entries
    .filter(([, m]) => typeof m?.price_blended === "number")
    .sort((a, b) => a[1].price_blended - b[1].price_blended || a[0].localeCompare(b[0]));
  if (priced.length > 0) {
    return { id: priced[0][0], why: `cheapest squad model at $${priced[0][1].price_blended}/M` };
  }

  const fallback = parse(sessionModel);
  if (fallback) {
    return { id: fallback, why: "no pricing data — fell back to the session's own model" };
  }
  return null;
}

/** Split `provider/model` for the summarize payload. */
export function splitModelId(id) {
  const s = String(id ?? "");
  const at = s.indexOf("/");
  if (at <= 0 || at >= s.length - 1) return null;
  return { providerID: s.slice(0, at), modelID: s.slice(at + 1) };
}

const k = (n) => `${Math.round(n / 1000)}k`;

/**
 * The tool's answer. States the outcome in tokens — the only number that says
 * whether this was worth doing — and the cache consequence, which the
 * orchestrator would otherwise discover as a surprise bill on the next
 * dispatch.
 *
 * @param {object} input
 * @param {string} input.taskId
 * @param {string} [input.agent]
 * @param {number} [input.before]
 * @param {number} [input.after]
 * @param {string} input.model
 * @param {string} input.why
 * @param {boolean} [input.timedOut]
 * @returns {string}
 */
export function formatCompactReport({ taskId, agent, before, after, model, why, timedOut }) {
  const who = agent ? `${agent} session` : "session";
  const size =
    typeof before === "number" && typeof after === "number"
      ? `~${k(before)} → ~${k(after)} tokens` +
        (after < before ? ` (−${Math.round((1 - after / before) * 100)}%)` : " (no reduction)")
      : typeof before === "number"
        ? `was ~${k(before)} tokens; the new size could not be read`
        : "size unknown";

  const lines = [
    `[COMPACTED] ${who} ${taskId} — ${size}. Summary written by ${model} (${why}).`,
    "Its prompt prefix changed, so this session's provider cache is now COLD: the next " +
      "dispatch re-uploads the compacted context once, then warms again.",
  ];
  if (timedOut) {
    lines.push(
      "NOTE: the compaction call did not return in time and was left running; the sizes above " +
        "may be stale. Re-read them from the next [CACHE STATUS] before drawing conclusions.",
    );
  }
  return lines.join(" ");
}
