// Compacting a SUBAGENT session on demand — the decision inputs and the report,
// kept pure so the plugin tool is just plumbing.
//
// WHY. Reuse of a subagent session is all-or-nothing today: pass the task_id and
// the whole history is re-read on every step, or start fresh and throw the
// history away. The middle option is OpenCode's session.compact, which accepts
// subagent sessions too and uses the host's compaction model settings.
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
