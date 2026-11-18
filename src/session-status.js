// The squad_session tool's report, as pure functions over a session's
// messages (V2 SessionMessageInfo[], as ctx.session.context returns them).
//
// WHY a pulled tool instead of notes appended to the `subagent` result:
// since OpenCode 2.3 every `subagent` call runs in the background. Its tool
// result is a stub ("working in the background"), and the real result arrives
// later as a synthetic `<subagent>` message no tool hook sees. A note on the stub
// described the session as it was BEFORE the dispatch, and the empty-result
// diagnosis ran on the stub. The orchestrator already holds every child's
// sessionID (in the stub and in the `<subagent>` message), so it asks at the
// moment it decides on reuse and gets numbers that are current, with the
// arithmetic already done: warm for N more seconds, or cold for N seconds.

import { resolveCacheTtl } from "./cache-status.js";
import { estimateContextTokens, formatLocalDateTime, formatThousands as k } from "./context.js";
import { formatTaskOutcome } from "./task-outcome.js";
import { normalizeUsageMessages } from "./v2/adapt.js";

/**
 * @param {number} ms
 * @returns {number} whole seconds, never negative (clock-skew safety)
 */
const secs = (ms) => Math.max(0, Math.round(ms / 1000));

/**
 * Facts about a session from its messages.
 *
 *   lastHitMs — the newest assistant message's request start: when the session
 *               last actually hit its provider, which is what the cache TTL
 *               counts from;
 *   running   — the newest assistant message has neither a finish reason nor a
 *               completion time, and no `idle` record follows it (the host
 *               appends one when the session stops, aborted or not). Without
 *               that record an abort and a live step look the same, so the
 *               report still says "probably";
 *   finish / …Tokens / resultEmpty — from the newest assistant message that
 *               COMPLETED (an abort can leave a stub after it);
 *   contextTokens — size as of the last completed turn.
 *
 * @param {readonly any[]} messages V2 SessionMessageInfo[]
 */
export function sessionFacts(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const assistants = list.filter((m) => m?.type === "assistant");
  const newest = assistants.at(-1);
  const stoppedAfter = list.slice(list.lastIndexOf(newest) + 1).some((m) => m?.type === "idle");
  const done = assistants.findLast((m) => typeof m?.finish === "string" && m.finish.length > 0);
  const model =
    newest?.model?.providerID && newest?.model?.id
      ? `${newest.model.providerID}/${newest.model.id}`
      : null;
  /** @param {any} m */
  const hasText = (m) =>
    Array.isArray(m?.content) &&
    m.content.some(
      (/** @type {any} */ c) => c?.type === "text" && typeof c.text === "string" && c.text.trim(),
    );
  return {
    agent: typeof newest?.agent === "string" ? newest.agent : null,
    model,
    providerID: newest?.model?.providerID ?? null,
    lastHitMs: typeof newest?.time?.created === "number" ? newest.time.created : null,
    running: Boolean(newest) && !newest.finish && !newest.time?.completed && !stoppedAfter,
    finish: done?.finish,
    outputTokens: done?.tokens?.output,
    reasoningTokens: done?.tokens?.reasoning,
    resultEmpty: done ? !hasText(done) : false,
    contextTokens: estimateContextTokens(normalizeUsageMessages(list))?.used,
  };
}

/**
 * @param {number} [tokens]
 * @param {number} [limit]
 */
function sizeText(tokens, limit) {
  if (typeof tokens !== "number" || tokens <= 0) return null;
  return typeof limit === "number" && limit > 0
    ? `~${k(tokens)} / ${k(limit)} (${Math.round((tokens / limit) * 100)}%)`
    : `~${k(tokens)}`;
}

/**
 * The session ids a squad_session call asks about. The schema declares an
 * array (a string-or-array union is not something every provider's tool
 * schema accepts), but a model that passes one bare id still gets its answer.
 * Deduplicated, blanks dropped.
 *
 * @param {any} input
 * @returns {string[]}
 */
export function requestedSessions(input) {
  const raw = input?.sessionIDs ?? input?.sessionID;
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return [...new Set(list.map((v) => String(v ?? "").trim()).filter(Boolean))];
}

/**
 * The wall clock line every squad_session report starts with.
 *
 * @param {number} now
 * @param {string} [timeZone]
 */
export function formatNow(now, timeZone) {
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `now: ${formatLocalDateTime(new Date(now), zone) ?? new Date(now).toISOString()}`;
}

/**
 * The report for one subagent session the orchestrator may reuse (without the
 * clock line: one squad_session call may cover several sessions).
 *
 * @param {{
 *   sessionID: string,
 *   facts: ReturnType<typeof sessionFacts>,
 *   ttlSeconds?: number,
 *   contextLimit?: number,
 *   now: number,
 * }} p
 * @returns {string}
 */
export function formatSessionStatus({ sessionID, facts, ttlSeconds, contextLimit, now }) {
  const who = [facts.agent, facts.model].filter(Boolean).join(", ");
  const lines = [`session ${sessionID}${who ? ` (${who})` : ""}`];

  if (facts.lastHitMs === null) {
    lines.push(
      "No provider request found in this session, so there is no cache to reuse. " +
        "Start a fresh session.",
    );
    return lines.join("\n");
  }

  const age = secs(now - facts.lastHitMs);
  const ttl =
    typeof ttlSeconds === "number"
      ? { seconds: ttlSeconds, source: "set in model_data.json" }
      : resolveCacheTtl(facts.providerID ?? undefined);
  const size = sizeText(facts.contextTokens, contextLimit);

  if (facts.running) {
    lines.push(
      `state: probably RUNNING — its current step started ${age} s ago and has not ` +
        "finished. The cache stays warm while it works. Wait for its <subagent> " +
        "message; to redirect it now, call subagent with this sessionID.",
    );
  } else if (age < ttl.seconds) {
    lines.push(
      `cache: WARM — expires in ${ttl.seconds - age} s (last provider request ${age} s ago, ` +
        `TTL ${ttl.seconds} s, ${ttl.source}).`,
    );
  } else {
    lines.push(
      `cache: COLD — expired ${age - ttl.seconds} s ago (last provider request ${age} s ago, ` +
        `TTL ${ttl.seconds} s, ${ttl.source}). Reusing it re-uploads its whole context ` +
        "at full price once.",
    );
  }
  if (size) {
    lines.push(
      `context: ${size} as of its last finished step. Reusing it re-reads all of ` +
        "that on every step; a fresh session starts from your brief.",
    );
  }

  const outcome = formatTaskOutcome({
    taskId: sessionID,
    providerModelId: facts.model ?? undefined,
    finish: facts.finish,
    outputTokens: facts.outputTokens,
    reasoningTokens: facts.reasoningTokens,
    resultEmpty: !facts.running && facts.resultEmpty,
  });
  if (outcome) lines.push(outcome);
  return lines.join("\n");
}

/**
 * The report for the caller's own session: the clock and its own context.
 *
 * @param {{contextTokens?: number, contextLimit?: number, now: number, timeZone?: string}} p
 * @returns {string}
 */
export function formatOwnStatus({ contextTokens, contextLimit, now, timeZone }) {
  const lines = [formatNow(now, timeZone)];
  const size = sizeText(contextTokens, contextLimit);
  if (size) lines.push(`your context: ${size} as of your last finished step.`);
  lines.push("Pass subagent sessionIDs to check whether reusing them is worth it.");
  return lines.join("\n");
}
