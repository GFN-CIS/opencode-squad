// Pure decision logic + orchestration for the `experimental.chat.messages.transform`
// hook, extracted out of the plugin entry point so it's directly unit-testable
// (previously this lived inline in .opencode/plugins/orchestrate.js as a single
// 21-CC anonymous function with zero direct test coverage).

import { BOOTSTRAP_MARKER, buildBootstrap } from "./bootstrap.js";
import {
  DEFAULT_LIMIT,
  estimateContextTokens,
  formatContextLine,
  formatLocalDateTime,
  resolveOrchestratorModel,
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
  const lastUser = [...messages].reverse().find((m) => m?.info?.role === "user" && m.parts?.length);
  if (!lastUser) return null;

  const leadText =
    lastUser.parts.find((p) => p?.type === "text" && typeof p.text === "string")?.text || "";
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
 * Per-turn memo for the injected block.
 *
 * WHY THIS EXISTS — it is a cost fix, not a micro-optimisation. The transform
 * hook fires on every REQUEST to the model, not once per user turn: a turn with
 * forty tool calls runs it forty times. Injections are not persisted, so each
 * call used to rebuild the block from scratch — with `nowText` fresh to the
 * second and a context percentage that moves as tool results land. That put
 * byte-different text at the same position in the prompt on every call, and
 * Anthropic's cache is prefix-matched: nothing at or after a changed byte can
 * be read back.
 *
 * Measured on one live orchestrator session (377 turns, claude-opus-5): the
 * cache read was pinned at a constant 52,147 / 40,946 tokens — the stable head
 * (system + tool defs) and not one byte of the conversation body — while ~195k
 * was re-written per call. 110 healthy turns cost ~$0.34 each; 266 turns in
 * that state cost ~$1.51. A non-transformed subagent session on the SAME model,
 * provider and day averaged 3.5k of cache write per turn against the
 * orchestrator's 195k. ~2.2k tokens of volatile text were invalidating ~195k of
 * cache.
 *
 * Keyed on the target message id, which is stable for every call within a turn
 * and changes when a new user message arrives — so the block is rebuilt exactly
 * when it should be. Bounded because one process can serve several orchestrator
 * sessions; a single slot would let two sessions evict each other on alternate
 * calls and silently restore the bug.
 *
 * @param {number} [limit]
 */
export function createTurnMemo(limit = 8) {
  /** @type {Map<string, {bootstrap: string, contextLine: string|null}>} */
  const entries = new Map();
  return {
    /** @param {string} id */
    get(id) {
      return entries.get(id) ?? null;
    },
    /**
     * @param {string} id
     * @param {{bootstrap: string, contextLine: string|null}} value
     */
    set(id, value) {
      entries.set(id, value);
      while (entries.size > limit)
        entries.delete(/** @type {string} */ (entries.keys().next().value));
    },
  };
}

/**
 * Apply this turn's injections (bootstrap + context-budget line) to the
 * target message in place. Side-effecting (mutates `target.parts`) because
 * that's what the plugin hook contract requires; everything decision-shaped
 * is delegated to the pure helpers above so it's testable without a message
 * array mutation assertion for every case.
 *
 * The injected text is built ONCE per turn and replayed byte-identically on
 * every later call in that turn — see `createTurnMemo`. That freezes two facts
 * at turn start: the clock and the context size. Both are stated as turn-start
 * values in the text itself, and `squad-delegate` §6 tells the orchestrator to
 * treat the frozen clock as a lower bound on now.
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
 * @param {ReturnType<typeof createTurnMemo>} [opts.turnMemo] omit and every
 *   call rebuilds the block, which is the old (cache-hostile) behaviour.
 */
export async function applyOrchestratorTransform(messages, opts) {
  const { orchestratorAgent, getInventory, getLimitMap, getHasSquad, orchestratorModel, turnMemo } =
    opts;

  const target = findInjectionTarget(messages, orchestratorAgent);
  if (!target) return;

  // Already injected on this array — the message carries this turn's block and
  // there is nothing to add. Returning here (rather than skipping only the
  // bootstrap) also stops a second call from appending a SECOND context line,
  // which would make the message differ byte-wise between calls and defeat the
  // whole point of the memo below.
  if (hasBootstrapMarker(target)) return;

  const refPart = target.parts[0];
  // No id (older payload shape, or a synthetic message) means no stable key to
  // memo on, so fall back to rebuilding — correct, just not cached.
  const turnId = target.info?.id ?? null;

  let block = turnId && turnMemo ? turnMemo.get(turnId) : null;
  if (!block) {
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

    let contextLine = null;
    const ctx = estimateContextTokens(messages);
    if (ctx) {
      const limits = await getLimitMap();
      const limit =
        limits[`${ctx.providerID}/${ctx.modelID}`] ?? limits[ctx.modelID] ?? DEFAULT_LIMIT;
      contextLine = formatContextLine(ctx.used, limit);
    }

    block = { bootstrap, contextLine };
    if (turnId && turnMemo) turnMemo.set(turnId, block);
  }

  // Not persisted by opencode, so this re-establishes the block every turn.
  target.parts.unshift({ ...refPart, type: "text", text: block.bootstrap });
  if (block.contextLine) {
    target.parts.push({ ...refPart, type: "text", text: block.contextLine });
  }
}
