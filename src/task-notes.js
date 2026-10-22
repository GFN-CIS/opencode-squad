// The [TASK OUTCOME] and [CACHE STATUS] notes appended to a finished subagent
// call, as pure functions over already-fetched data. Shared by the OpenCode 1
// entry (the `task` tool) and the OpenCode 2 entry (the `subagent` tool); each
// entry only fetches the subagent's messages and converts them to V1 `{info}`
// items.

import { formatCacheStatus, resolveCacheTtl } from "./cache-status.js";
import { estimateContextTokens, formatLocalDateTime } from "./context.js";
import { formatTaskOutcome } from "./task-outcome.js";

/**
 * Facts about a subagent session from its messages:
 *   lastHitMs     — the newest assistant message's request-start time, i.e.
 *                   when this session last actually hit its provider;
 *   finish/…Tokens — from the newest assistant turn that actually COMPLETED. A
 *                   session can end with a stub assistant record (no finish,
 *                   all-zero tokens) after an abort, and reading the outcome off
 *                   that stub would report "no finish reason" for every
 *                   cancelled task. Deliberately a separate scan from
 *                   lastHitMs, which wants the newest provider contact whether
 *                   or not it finished;
 *   contextTokens — how big its context grew (last completed turn). Missing
 *                   usage must not suppress the cache-status line — it degrades
 *                   to the note without the size clause.
 *
 * @param {Array<{info?: any}>} messages V1 `{info}` items
 */
export function subagentUsage(messages) {
  let lastHitMs = null;
  let finish;
  let outputTokens;
  let reasoningTokens;
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i]?.info;
    if (info?.role !== "assistant") continue;
    if (lastHitMs === null && typeof info?.time?.created === "number") {
      lastHitMs = info.time.created;
    }
    if (finish === undefined && typeof info?.finish === "string" && info.finish.length > 0) {
      finish = info.finish;
      outputTokens = info?.tokens?.output;
      reasoningTokens = info?.tokens?.reasoning;
    }
    if (lastHitMs !== null && finish !== undefined) break;
  }
  const ctx = estimateContextTokens(messages);
  return { lastHitMs, contextTokens: ctx?.used, finish, outputTokens, reasoningTokens };
}

/**
 * The notes to append, in order: [TASK OUTCOME] first (a fact about THIS call
 * the orchestrator has to act on — appended even when the model or the
 * timestamp is unknown, since suppressing it there would restore the blind spot
 * it exists to close), then [CACHE STATUS] (advice about a possible next call,
 * only when the model and a usable timestamp are known).
 *
 * @param {object} input
 * @param {string} input.taskId
 * @param {string} [input.providerID]
 * @param {string} [input.modelID]
 * @param {ReturnType<typeof subagentUsage> & {usageUnknown?: boolean}} input.usage
 * @param {boolean} input.resultEmpty
 * @param {Record<string, any> | null} input.modelData model_data.json models
 * @param {Record<string, number> | undefined} input.limitMap
 * @param {number} input.now
 * @param {string} [input.timeZone]
 * @returns {string[]}
 */
export function taskNotes({
  taskId,
  providerID,
  modelID,
  usage,
  resultEmpty,
  modelData,
  limitMap,
  now,
  timeZone,
}) {
  const notes = [];
  const outcome = formatTaskOutcome({
    taskId,
    providerModelId: providerID && modelID ? `${providerID}/${modelID}` : undefined,
    finish: usage.finish,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    resultEmpty,
    usageUnknown: usage.usageUnknown,
  });
  if (outcome) notes.push(outcome);

  if (!providerID || !modelID || usage.lastHitMs === null || usage.lastHitMs === undefined) {
    return notes;
  }

  // model_data.json wins when the user has filled it in; otherwise resolve
  // from the provider. Without that fallback the hint degraded to "TTL isn't
  // published — judge for yourself" for every anthropic model, because the
  // hand-edited field was simply never filled in.
  const configuredTtl = modelData?.[`${providerID}/${modelID}`]?.cache_ttl_seconds;
  const ttl =
    typeof configuredTtl === "number"
      ? { seconds: configuredTtl, source: /** @type {const} */ ("published") }
      : resolveCacheTtl(providerID);
  const contextLimit = limitMap?.[`${providerID}/${modelID}`] ?? limitMap?.[modelID];
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  notes.push(
    formatCacheStatus({
      taskId,
      providerModelId: `${providerID}/${modelID}`,
      lastHitMs: usage.lastHitMs,
      // Absolute wall clock in the same format/zone the bootstrap stamps its
      // own "now" with, so the orchestrator can recompute the gap at the next
      // delegation instead of trusting a stale relative age.
      lastHitAtText: formatLocalDateTime(new Date(usage.lastHitMs), zone) ?? undefined,
      // The orchestrator's own clock is frozen at the start of its turn (see
      // src/message-transform.js), so this stamp is the tighter lower bound on
      // "now" when it computes a reuse gap later in the same turn.
      nowAtText: formatLocalDateTime(new Date(now), zone) ?? undefined,
      ttlSeconds: ttl.seconds,
      ttlSource: ttl.source,
      contextTokens: usage.contextTokens,
      contextLimit,
      now,
    }),
  );
  return notes;
}
