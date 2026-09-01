// Pure formatting for the [TASK OUTCOME] note appended to a finished task's
// result (see the `tool.execute.after` hook on "task" in the plugin).
//
// Goal: explain an empty or truncated `<task_result>`.
//
// opencode's `task` tool reports `state="completed"` and the subagent's final
// text, and nothing else — no finish reason, no token split. So two completely
// different failures arrive at the orchestrator as the same empty string:
//
//   a) the model was cut off at max_tokens before it emitted anything, and
//   b) the model genuinely ended its turn with no final message.
//
// Observed 2026-09-01 (ses_fa3e7d7a6ffenuME30B4y0It5x, zai-coding-plan/glm-5.3
// and its -flash sibling on the same brief): `finish: "length"`, `reasoning:
// ~32000`, `output: 2` and `9`. Both models spent the entire budget inside the
// reasoning channel — ~133 KB of it, holding 70 fenced code blocks of real
// drafted work — and were truncated one step before writing any file. Given
// only "" to look at, the orchestrator concluded the provider had refused the
// request, which nothing in the session supported, and switched providers
// instead of shortening the brief or raising the cap.
//
// A wrong diagnosis is worse than a missing one, because the orchestrator acts
// on it. So this note reports the mechanism from the numbers and, when the
// numbers say truncation, says outright that this is NOT a provider failure —
// that being the specific wrong turn it exists to prevent.

/**
 * Reasoning is treated as having eaten the budget when it dwarfs the visible
 * output. The ratio (rather than an absolute floor) keeps this meaningful
 * across models with very different reasoning verbosity: a run that emitted a
 * real answer alongside heavy reasoning is not this failure.
 */
const REASONING_DOMINANCE_RATIO = 4;

/**
 * @param {number} n
 * @returns {string}
 */
function tokens(n) {
  return `${n} token${n === 1 ? "" : "s"}`;
}

/**
 * @param {{
 *   taskId: string,
 *   providerModelId?: string,
 *   finish?: string,
 *   outputTokens?: number,
 *   reasoningTokens?: number,
 *   resultEmpty: boolean,
 *   usageUnknown?: boolean,
 * }} info
 * @returns {string}  "" when the outcome is unremarkable and needs no note
 */
export function formatTaskOutcome(info) {
  const out = typeof info.outputTokens === "number" ? info.outputTokens : null;
  const reasoning = typeof info.reasoningTokens === "number" ? info.reasoningTokens : null;
  const truncated = info.finish === "length";

  // Nothing to explain: a normal finish that produced a result.
  if (!truncated && !info.resultEmpty) return "";

  const head = `[TASK OUTCOME] task_id=${info.taskId}`;

  // "We could not read the session" must never be dressed up as "the subagent
  // stopped on its own". A missing finish reason because the fetch failed and a
  // present finish reason that says the turn ended cleanly are different facts,
  // and collapsing them would reintroduce exactly the invented diagnosis this
  // whole note exists to prevent — one level down.
  if (info.usageUnknown) {
    return (
      `${head} returned an empty result, and its session could not be read — so the cause is ` +
      `UNKNOWN. It may have been truncated at max_tokens or ended on its own; nothing here ` +
      `distinguishes the two. Open that session before you diagnose it, and do not attribute ` +
      `this to the provider or the brief.`
    );
  }
  const model = info.providerModelId ? ` (${info.providerModelId})` : "";
  // Finish reason and token split share one parenthesis so the sentence still
  // reads when either half is missing — the token split is the evidence for the
  // finish reason, not a second independent clause.
  const detail = (finishLabel) => {
    const bits = [];
    if (finishLabel) bits.push(finishLabel);
    if (out !== null && reasoning !== null) {
      bits.push(`${tokens(out)} output, ${tokens(reasoning)} reasoning`);
    }
    return bits.length > 0 ? ` (${bits.join("; ")})` : "";
  };

  if (truncated) {
    const inReasoning =
      out !== null &&
      reasoning !== null &&
      reasoning > Math.max(out, 1) * REASONING_DOMINANCE_RATIO;

    // Truncation with nothing emitted: the case that reads as a refusal.
    if (info.resultEmpty) {
      return (
        `${head}${model} hit max_tokens${detail("finish=length")} and was cut off before emitting ` +
        `anything — the result is empty because the turn never reached one, not because the ` +
        `provider refused or the brief was rejected. ` +
        (inReasoning
          ? `The budget went into the reasoning channel, so the work may exist there as ` +
            `drafts; read that session's reasoning before rewriting the brief from scratch. `
          : "") +
        `Do not switch providers on this signal. Fix the cap: shorten the brief, split the task, ` +
        `or dispatch a model with room to answer.`
      );
    }

    // Truncation with partial output: the answer that is there is unfinished.
    return (
      `${head}${model} hit max_tokens${detail("finish=length")} — the result below is CUT OFF ` +
      `mid-answer, not a finished deliverable. Treat it as partial: verify what actually landed ` +
      `on disk rather than trusting the summary.`
    );
  }

  // Empty result on an otherwise normal finish. Genuinely different from
  // truncation, and worth naming as such so the two don't get conflated in the
  // other direction either.
  return (
    `${head}${model} returned an empty result on a normal finish` +
    `${detail(info.finish ? `finish=${info.finish}` : "")}. ` +
    `The turn ended without a final message — the subagent stopped rather than ` +
    `being cut off. Check whether it wrote any files before assuming the brief failed.`
  );
}

/**
 * Pulls the `<task_result>` payload out of a `task` tool result string, to tell
 * an empty deliverable from a present one. The tool wraps the subagent's final
 * text in that element; anything the plugin has already appended (the
 * [CACHE STATUS] line) lives outside it, so matching the element rather than
 * trimming the whole string keeps this honest.
 *
 * @param {unknown} toolOutput
 * @returns {boolean}  true when there is no task_result, or it is blank
 */
export function isTaskResultEmpty(toolOutput) {
  if (typeof toolOutput !== "string") return true;
  const match = toolOutput.match(/<task_result>([\s\S]*?)<\/task_result>/);
  if (!match) return toolOutput.trim().length === 0;
  return match[1].trim().length === 0;
}
