// Pure formatting for the [CACHE STATUS] note appended to a completed task's
// result (see the `tool.execute.after` hook on "task" in the plugin).
//
// Goal: when a `task` tool call finishes, tell the orchestrator how long ago
// that subagent session last actually hit its provider, and whether that's
// still inside the provider's prompt-cache TTL — so it can decide whether
// passing this session's task_id back in (to reuse the cache) is still worth
// it, or whether the cache has gone cold and a fresh session is no better.
//
// TTL numbers are NOT hardcoded here. They come from the hand-editable
// `cache_ttl_seconds` field in model_data.json (same file/pattern as `info`
// and `billing` — see src/model-data.js), because published TTLs vary by
// provider and some (alibaba-token-plan, zai-coding-plan, as of 2026-08) don't
// publish one at all. Absent/non-numeric -> honestly reported as "unknown",
// never guessed.

function humanizeSeconds(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

/**
 * @param {{
 *   taskId: string,
 *   providerModelId: string,
 *   lastHitMs: number,
 *   ttlSeconds?: number,
 *   now: number,
 * }} info
 * @returns {string}
 */
export function formatCacheStatus(info) {
  const ageSeconds = Math.max(0, (info.now - info.lastHitMs) / 1000);
  const ageStr = humanizeSeconds(ageSeconds);

  const ttlLine =
    typeof info.ttlSeconds === "number"
      ? `published cache TTL ~${humanizeSeconds(info.ttlSeconds)} — ${
          ageSeconds < info.ttlSeconds ? "likely still warm" : "likely cold by now"
        }`
      : "cache TTL for this provider isn't published — judge for yourself";

  return (
    `[CACHE STATUS] task_id=${info.taskId} — last provider hit ~${ageStr} ago (${info.providerModelId}). ` +
    `${ttlLine}. Pass task_id to continue this same session if you want to reuse it.`
  );
}
