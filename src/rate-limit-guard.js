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
  // Polling backstop (see isSilentHang below): independent of both event
  // paths above, catches a subagent that has gone completely silent — no
  // message/part activity at all — because the provider/SDK is retrying
  // internally without ever surfacing a session.status:retry or a terminal
  // message.updated error. Verified live: a real "token-plan quota
  // exhausted" AI_APICallError produced ZERO such events for 10+ minutes
  // while opencode kept retrying under the hood. 10 minutes is a deliberate
  // middle ground — long enough that a legitimately slow first-token (heavy
  // reasoning models can take a couple minutes before streaming anything)
  // won't false-positive, short enough that it doesn't cost the orchestrator
  // the better part of an hour before it finds out.
  max_silence_seconds: 600,
  poll_interval_seconds: 15,
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
 * Whether a TERMINAL failure (a subagent's message ended with `.error` set,
 * with no `session.status` retry ever seen for it) looks like a rate/usage
 * limit. This covers failures opencode's own `retryable()` never classified
 * as retryable in the first place — e.g. a provider error whose message is
 * "Your token-plan quota has been exhausted", which matches none of
 * opencode's built-in RETRYABLE_MESSAGE_PATTERNS, so no retry schedule ever
 * engages and the whole thing fails (or gets cancelled) on the very first
 * attempt with no `session.status` signal at all. Without this check, the
 * orchestrator only ever sees the task tool's generic "Task cancelled" text
 * and has no way to know it was actually a limit.
 *
 * @param {string} errorText raw error message/text (whatever was available)
 * @param {ReturnType<typeof normalizeGuardConfig>} config
 * @param {number | undefined} statusCode
 */
export function isGuardedTerminalError(errorText, config, statusCode) {
  if (statusCode !== undefined && config.retry_on_errors.includes(statusCode)) return true;
  return matchesPattern(errorText, config.retryable_error_patterns);
}

/**
 * Third detection path, orthogonal to the two event-driven ones above
 * (`isGuardedRetry` / `isGuardedTerminalError`). Both of those require
 * opencode to emit a specific event — a `session.status:retry`, or a
 * terminal `message.updated`/`session.error`. Neither fires for a subagent
 * whose provider call is being retried internally by the SDK/provider layer
 * with no event surfaced at all (verified live — see max_silence_seconds
 * above). This is a pure wall-clock check meant to be called on a timer by
 * the caller (polling), not from an event handler.
 *
 * @param {number} lastActivityMs epoch ms of the last observed message/part
 *        activity for the session (or its creation time if nothing has
 *        happened yet)
 * @param {ReturnType<typeof normalizeGuardConfig>} config
 * @param {number} now epoch ms (injected for testability)
 */
export function isSilentHang(lastActivityMs, config, now) {
  return now - lastActivityMs > config.max_silence_seconds * 1000;
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
 * @returns {{trigger: false} | {trigger: true, reason: "single_wait" | "cumulative", waitMs: number, cumulativeMs: number, until: number}}
 */
export function evaluateRetry(state, status, config, lastStatusCode, now) {
  if (state.guarded) return { trigger: false };
  if (!isGuardedRetry(status, config, lastStatusCode)) return { trigger: false };

  const waitMs = Math.max(0, status.next - now);
  state.cumulativeMs += waitMs;
  // `status.next` is the provider's own announced wake-up time for THIS retry
  // (absolute epoch ms) — the only "until" we actually have. For `cumulative`
  // it's not a guarantee (the provider may announce a new, later wait on the
  // very next retry), but it's still the best honest lower bound we can give
  // the orchestrator instead of silence.
  const until = status.next;

  if (waitMs > config.max_wait_seconds * 1000) {
    return { trigger: true, reason: "single_wait", waitMs, cumulativeMs: state.cumulativeMs, until };
  }
  if (state.cumulativeMs > config.max_cumulative_seconds * 1000) {
    return { trigger: true, reason: "cumulative", waitMs, cumulativeMs: state.cumulativeMs, until };
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
 * `reason: "terminal_error"` is a different case: the subagent's call already
 * failed/ended on its own (no `session.status` retry was ever seen — see
 * `isGuardedTerminalError`) and this guard did NOT abort anything. It just
 * recognized the failure text as limit-shaped and is explaining it after the
 * fact, since the task tool's own error would otherwise just read as the
 * bare underlying provider error (or opencode's generic "Task cancelled")
 * with no hint that switching models would fix it.
 *
 * `reason: "silent_hang"` is the third case, from the polling backstop
 * (`isSilentHang`): no event of any kind was ever seen for the subagent —
 * this guard abort it purely because the wall clock ran out, so there is no
 * error text and no retry-after to report at all.
 *
 * @param {{model: string, provider: string, reason: "single_wait" | "cumulative" | "terminal_error" | "silent_hang", waitMs?: number, cumulativeMs?: number, until?: number, silentMs?: number, description?: string, errorText?: string}} info
 */
export function formatGuardNote(info) {
  // `until` is an absolute epoch ms (from the provider's own retry-after
  // signal) when we have one; otherwise honestly say "unknown" instead of
  // implying a deadline that doesn't exist (e.g. terminal_error/silent_hang
  // never saw a retry event at all, so there's nothing to base a deadline on).
  const untilStr = info.until ? new Date(info.until).toISOString() : "unknown";

  if (info.reason === "terminal_error") {
    return [
      "[RATE LIMIT GUARD]",
      `The task${info.description ? ` "${info.description}"` : ""} on \`${info.model}\` (${info.provider}) failed with an error matching this guard's rate/usage-limit patterns${info.errorText ? `: "${info.errorText}"` : ""}.`,
      `Rate limited till ${untilStr}.`,
      "This is NOT a real task failure — it never got a chance to run.",
      "Pick a different grunt/drill (a different model/provider) from your inventory and retry the same task.",
    ].join(" ");
  }
  if (info.reason === "silent_hang") {
    const silentStr = humanizeSeconds((info.silentMs ?? 0) / 1000);
    return [
      "[RATE LIMIT GUARD]",
      `The task${info.description ? ` "${info.description}"` : ""} on \`${info.model}\` (${info.provider}) produced no activity at all for ~${silentStr} and was aborted — likely a provider/SDK-internal retry loop that never surfaced as a visible error or retry signal.`,
      `Rate limited till ${untilStr}.`,
      "This is NOT a real task failure — it never got a chance to run.",
      "Pick a different grunt/drill (a different model/provider) from your inventory and retry the same task.",
    ].join(" ");
  }
  const waitStr = humanizeSeconds((info.waitMs ?? 0) / 1000);
  const cumulativeStr = humanizeSeconds((info.cumulativeMs ?? 0) / 1000);
  const why =
    info.reason === "single_wait"
      ? `the provider reported a wait of ~${waitStr} before it would retry`
      : `retries have accumulated ~${cumulativeStr} of total wait without succeeding`;
  return [
    "[RATE LIMIT GUARD]",
    `The task${info.description ? ` "${info.description}"` : ""} on \`${info.model}\` (${info.provider}) was cancelled because ${why} — past this guard's configured threshold.`,
    `Rate limited till ${untilStr}${info.reason === "cumulative" ? " (last announced wait — the provider may extend this on the next retry)" : ""}.`,
    "This is NOT a real task failure. Do not wait for this model to recover.",
    "Pick a different grunt/drill (a different model/provider) from your inventory and retry the same task.",
  ].join(" ");
}
