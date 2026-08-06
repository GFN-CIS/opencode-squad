// Pure decision logic for the subagent rate-limit guard.
//
// opencode's own retry policy (packages/opencode/src/session/retry.ts) retries
// a rate-limited/overloaded provider call FOREVER, honoring the provider's
// `retry-after`/`retry-after-ms` header up to ~24.8 days (the int32 setTimeout
// ceiling), or a 30s-capped exponential backoff when no header is present.
// There is no config surface for this in opencode core — confirmed by reading
// the schema and the retry policy itself. For a subagent (dispatched via the
// `task` tool), that means the orchestrator sits blocked for however long the
// provider says to wait, with no way to know it could just pick a different
// model instead.
//
// This module decides WHEN to intervene (abort the stuck subagent session)
// based on two independent rules, mirroring the two scenarios from the
// design discussion:
//   1. single-wait  — the provider announced a wait longer than
//      `max_wait_seconds` in one shot (e.g. "resets in 7 days"). Don't wait
//      at all — abort on the very first retry signal.
//   2. cumulative    — no single wait was long, but retries have been
//      accumulating (e.g. repeated short backoffs) past `max_cumulative_seconds`
//      total. Abort once the sum crosses the line.
//
// Deliberately scoped to SUBAGENT sessions only (sessions with a parentID) —
// a top-level/human chat session is left to opencode's native behavior (or a
// different plugin, e.g. @renjfk/opencode-model-fallback, which the user is
// free to run alongside this for that case).

const DEFAULT_CONFIG = {
  enabled: true,
  retry_on_errors: [429],
  retryable_error_patterns: ["rate.?limit", "usage.?limit", "quota"],
  max_wait_seconds: 3600,
  max_cumulative_seconds: 3600,
};

/** @param {Partial<typeof DEFAULT_CONFIG>} [raw] */
export function normalizeGuardConfig(raw) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    retry_on_errors: Array.isArray(raw?.retry_on_errors)
      ? raw.retry_on_errors
      : DEFAULT_CONFIG.retry_on_errors,
    retryable_error_patterns: Array.isArray(raw?.retryable_error_patterns)
      ? raw.retryable_error_patterns
      : DEFAULT_CONFIG.retryable_error_patterns,
  };
}

/**
 * Whether a piece of retry-status text (the friendly message opencode's own
 * `retryable()` already produced, plus any `action.reason`/`action.message`)
 * matches one of the configured patterns. Same lenient regex-or-substring
 * fallback as @renjfk/opencode-model-fallback, so a bad user-supplied pattern
 * degrades to a plain substring check instead of throwing.
 */
function matchesPattern(text, patterns) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(text);
    } catch {
      return lower.includes(String(pattern).toLowerCase());
    }
  });
}

/**
 * Whether a "retry" session.status event is one this guard should even
 * consider. `status.message` is opencode's own already-formatted retry
 * message (e.g. the GoUsageLimitError message embeds "It will reset in ...");
 * `status.action` (when present) carries a structured `reason`/`message` too.
 * `lastStatusCode`, if known (cached from a prior session.error/message.updated
 * event on the same session), is checked against `retry_on_errors`.
 *
 * @param {{message: string, action?: {reason?: string, message?: string}}} status
 * @param {ReturnType<typeof normalizeGuardConfig>} config
 * @param {number | undefined} lastStatusCode
 */
export function isGuardedRetry(status, config, lastStatusCode) {
  if (lastStatusCode !== undefined && config.retry_on_errors.includes(lastStatusCode)) return true;
  const text = [status?.message, status?.action?.reason, status?.action?.message]
    .filter(Boolean)
    .join(" ");
  return matchesPattern(text, config.retryable_error_patterns);
}

/**
 * Per-session tracking state the caller (the plugin) owns and mutates across
 * events. Kept as a plain object so it's trivially testable without a Map.
 * @typedef {{cumulativeMs: number, guarded: boolean}} GuardState
 */

/** @returns {GuardState} */
export function initGuardState() {
  return { cumulativeMs: 0, guarded: false };
}

/**
 * Decide whether THIS retry event should trigger an abort, and update the
 * running cumulative-wait tally. Pure — the caller performs the actual
 * abort/notify side effects based on the returned reason.
 *
 * @param {GuardState} state mutated in place (cumulativeMs updated)
 * @param {{attempt: number, message: string, action?: object, next: number}} status
 * @param {ReturnType<typeof normalizeGuardConfig>} config
 * @param {number | undefined} lastStatusCode
 * @param {number} now epoch ms (injected for testability)
 * @returns {{trigger: false} | {trigger: true, reason: "single_wait" | "cumulative", waitMs: number, cumulativeMs: number}}
 */
export function evaluateRetry(state, status, config, lastStatusCode, now) {
  if (state.guarded) return { trigger: false };
  if (!isGuardedRetry(status, config, lastStatusCode)) return { trigger: false };

  const waitMs = Math.max(0, status.next - now);
  state.cumulativeMs += waitMs;

  if (waitMs > config.max_wait_seconds * 1000) {
    return { trigger: true, reason: "single_wait", waitMs, cumulativeMs: state.cumulativeMs };
  }
  if (state.cumulativeMs > config.max_cumulative_seconds * 1000) {
    return { trigger: true, reason: "cumulative", waitMs, cumulativeMs: state.cumulativeMs };
  }
  return { trigger: false };
}

function humanizeSeconds(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3_600);
  const minutes = Math.ceil((s % 3_600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return "less than a minute";
}

/**
 * The synthetic follow-up message sent to the PARENT (orchestrator) session
 * once it's idle again, after the guard aborted a stuck subagent. The task
 * tool's own error text is hardcoded to "Task cancelled" (opencode has no API
 * to set custom text there — verified live), so this is the only channel that
 * actually carries the reason and the instruction to reroute.
 *
 * @param {{model: string, provider: string, reason: "single_wait" | "cumulative", waitMs: number, cumulativeMs: number, description?: string}} info
 */
export function formatGuardNote(info) {
  const waitStr = humanizeSeconds(info.waitMs / 1000);
  const cumulativeStr = humanizeSeconds(info.cumulativeMs / 1000);
  const why =
    info.reason === "single_wait"
      ? `the provider reported a wait of ~${waitStr} before it would retry`
      : `retries have accumulated ~${cumulativeStr} of total wait without succeeding`;
  return [
    "[RATE LIMIT GUARD]",
    `The task${info.description ? ` "${info.description}"` : ""} on \`${info.model}\` (${info.provider}) was cancelled because ${why} — past this guard's configured threshold.`,
    "This is NOT a real task failure. Do not wait for this model to recover.",
    "Pick a different grunt/drill (a different model/provider) from your inventory and retry the same task.",
  ].join(" ");
}
