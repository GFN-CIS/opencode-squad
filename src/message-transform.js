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
