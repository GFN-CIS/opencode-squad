// Pure decision logic + orchestration for the `experimental.chat.messages.transform`
// hook, extracted out of the plugin entry point so it's directly unit-testable
// (previously this lived inline in .opencode/plugins/orchestrate.js as a single
// 21-CC anonymous function with zero direct test coverage).

import { buildBootstrap, BOOTSTRAP_MARKER } from "./bootstrap.js";
import {
  estimateContextTokens,
  formatContextLine,
  DEFAULT_LIMIT,
  resolveOrchestratorModel,
  formatLocalDateTime,
} from "./context.js";

/**
 * opencode's own internal generations (title / summary / compaction) send a
 * synthetic prompt through the same session — injecting our bootstrap text
 * into that payload would pollute the produced title or summary.
 * @param {string} text
 */
export function isInternalGeneration(text) {
  return (
    /^\s*Generate a title for this conversation/.test(text) ||
    /^\s*Summarize what was done in this conversation/.test(text)
  );
}

/**
 * Find the message this turn's injections should land on: the latest
 * user-role message with parts, in an orchestrator (agent-tagged) session,
 * that isn't one of opencode's own internal generations. Returns null when
 * there's nothing to inject into (wrong agent, no user message, or an
 * internal generation).
 *
 * @param {Array<{info?: {agent?: string, role?: string}, parts?: Array<{type?: string, text?: string}>}>} messages
 * @param {string} orchestratorAgent
 */
export function findInjectionTarget(messages, orchestratorAgent) {
  if (!messages || messages.length === 0) return null;

  // Gate on whether ANY message is tagged with the orchestrator agent —
  // robust across a compaction, where the leading message becomes a summary
  // (agent="compaction") and a partless synthetic user marker can head the
  // payload. Gating on the first user message's agent alone silently drops
  // the injection after every compaction. Subagent (grunt/drill) sessions
  // carry their own agent, never the orchestrator's, so they're skipped too.
  if (!messages.some((m) => m?.info?.agent === orchestratorAgent)) return null;

  // The LATEST user message with parts is the current turn — always present
  // and re-sent, so injections survive compaction (which drops/summarizes
  // the original first message).
  const lastUser = [...messages]
    .reverse()
    .find((m) => m?.info?.role === "user" && m.parts?.length);
  if (!lastUser) return null;

  const leadText =
    lastUser.parts.find((p) => p?.type === "text" && typeof p.text === "string")
      ?.text || "";
  if (isInternalGeneration(leadText)) return null;

  return lastUser;
}

/** @param {{parts?: Array<{type?: string, text?: string}>}} message */
export function hasBootstrapMarker(message) {
  return !!message.parts?.some(
    (p) => p?.type === "text" && p.text && p.text.includes(BOOTSTRAP_MARKER),
  );
}

/**
 * Apply this turn's injections (bootstrap + live context-budget line) to the
 * target message in place. Side-effecting (mutates `target.parts`) because
 * that's what the plugin hook contract requires; everything decision-shaped
 * is delegated to the pure helpers above so it's testable without a message
 * array mutation assertion for every case.
 *
 * @param {Array<object>} messages full message history for this turn
 * @param {object} opts
 * @param {string} opts.orchestratorAgent
 * @param {() => Promise<string>} opts.getInventory
 * @param {() => Promise<Record<string, number>>} opts.getLimitMap
 * @param {() => boolean} opts.getHasSquad called AFTER getInventory() resolves
 *   (it populates the flag as a side effect) — a plain boolean captured
 *   before that call would always be stale on first run.
 * @param {string | null} opts.orchestratorModel fallback model text for turn 1
 */
export async function applyOrchestratorTransform(messages, opts) {
  const { orchestratorAgent, getInventory, getLimitMap, getHasSquad, orchestratorModel } = opts;

  const target = findInjectionTarget(messages, orchestratorAgent);
  if (!target) return;

  const refPart = target.parts[0];

  // Bootstrap — ensure it is present this turn (idempotent within the call).
  // Not persisted by opencode, so this re-establishes it every turn.
  if (!hasBootstrapMarker(target)) {
    const inventory = await getInventory();
    const nowText = formatLocalDateTime(
      new Date(),
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    const modelText = resolveOrchestratorModel(messages) ?? orchestratorModel ?? null;
    const bootstrap = buildBootstrap(inventory, {
      nowText,
      modelText,
      hasSquad: getHasSquad(),
    });
    target.parts.unshift({ ...refPart, type: "text", text: bootstrap });
  }

  // Live context-budget line on the same target message.
  const ctx = estimateContextTokens(messages);
  if (ctx) {
    const limits = await getLimitMap();
    const limit =
      limits[`${ctx.providerID}/${ctx.modelID}`] ?? limits[ctx.modelID] ?? DEFAULT_LIMIT;
    const line = formatContextLine(ctx.used, limit);
    if (line) target.parts.push({ ...refPart, type: "text", text: line });
  }
}
