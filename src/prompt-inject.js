// Keep a generated agent's role prompt live: swap the body that was frozen
// into its file at generation time for the one bundled with the plugin RIGHT
// NOW, on every request, via `experimental.chat.system.transform`.
//
// WHY. `prompts/grunt.md` / `prompts/drill.md` are inlined into every generated
// agent file by src/workers.js, because opencode's `task` tool takes only a
// `subagent_type` and the per-model agent file is the only place a model can be
// pinned. That makes each file a COPY: editing the bundled prompt changed
// nothing for a squad already on disk until someone re-ran squad-draft by hand
// — a manual step nobody remembers, and the copies drift silently.
//
// opencode builds the system prompt per request as
//   system[0] = [agent.prompt, ...system, user.system].join("\n")
// and then triggers the hook with that array (verified in the 1.18 bundle,
// `LLMRequestPrep.prepare`, and observed firing for a real grunt subagent
// session, not just primary agents). So the fix is a string splice on
// system[0].
//
// The role travels INSIDE the text, in the fence markers written by
// `agentMarkdown`. That is deliberate: the hook's input carries only
// {sessionID, model} — no agent name — so the alternative was an async lookup
// of the session's agent on every request. A fence is self-describing, needs no
// lookup, works for project-scoped agents, and its absence is the correct
// no-op for sarge and for hand-authored agents.
//
// Two properties this must keep:
//
//   1. The file on disk stays a COMPLETE, valid prompt. This is an override,
//      never the only copy — if the plugin is missing, older than the agent, or
//      the prompt file is unreadable, the agent still runs on the body it was
//      generated with. Degrade to stale, never to blank.
//
//   2. Nothing volatile goes in. This text sits in the cache prefix, so a clock
//      or a counter here would invalidate the whole conversation on every call
//      — the exact failure that cost one orchestrator session ~195k of cache
//      write per turn (see src/message-transform.js).

/** @param {string} role */
export function promptOpen(role) {
  return `<!-- squad:prompt role=${role} -->`;
}

export const PROMPT_CLOSE = "<!-- /squad:prompt -->";

const OPEN_RE = /<!-- squad:prompt role=([a-z][a-z0-9-]*) -->/;

/**
 * Wrap a role prompt body in the fence that makes it replaceable later.
 *
 * @param {string} role
 * @param {string} body
 * @returns {string}
 */
export function wrapPrompt(role, body) {
  return `${promptOpen(role)}\n${String(body).trim()}\n${PROMPT_CLOSE}`;
}

/**
 * Locate the fence in a system prompt.
 *
 * Only the FIRST fence is considered: one agent file carries one role prompt,
 * and a second one would mean something built a payload we do not understand —
 * in which case doing nothing is the safe reading.
 *
 * @param {string} text
 * @returns {{role: string, start: number, end: number} | null}  `start`/`end`
 *   bound the whole fenced span, markers included.
 */
export function findPromptFence(text) {
  if (typeof text !== "string") return null;
  const open = OPEN_RE.exec(text);
  if (!open) return null;
  const closeAt = text.indexOf(PROMPT_CLOSE, open.index + open[0].length);
  if (closeAt === -1) return null;
  return { role: open[1], start: open.index, end: closeAt + PROMPT_CLOSE.length };
}

/**
 * Replace the fenced role prompt in `system[0]` with the current bundled body.
 *
 * Mutates in place rather than pushing a new entry: opencode collapses
 * `system[1..]` into a second message (and, for openai-oauth, into
 * `instructions`), so appending would move a cache breakpoint. Splicing
 * system[0] leaves the request shape untouched.
 *
 * The replacement re-emits the fence, so a double fire — two plugin copies
 * loaded from `.opencode/plugin` and `.opencode/plugins`, which is a real
 * configuration people end up in — is idempotent rather than cumulative.
 *
 * @param {unknown} system  the hook's `output.system`
 * @param {(role: string) => string | null} loadPrompt  current body for a role,
 *   or null when it cannot be read — in which case nothing is touched and the
 *   agent keeps the body it was generated with.
 * @returns {{applied: boolean, role?: string, changed?: boolean}}
 */
export function applySystemPromptTransform(system, loadPrompt) {
  if (!Array.isArray(system) || typeof system[0] !== "string") return { applied: false };
  const fence = findPromptFence(system[0]);
  if (!fence) return { applied: false };

  let body;
  try {
    body = loadPrompt(fence.role);
  } catch {
    return { applied: false, role: fence.role };
  }
  if (typeof body !== "string" || !body.trim()) return { applied: false, role: fence.role };

  const next = wrapPrompt(fence.role, body);
  const current = system[0].slice(fence.start, fence.end);
  if (current === next) return { applied: true, role: fence.role, changed: false };

  system[0] = system[0].slice(0, fence.start) + next + system[0].slice(fence.end);
  return { applied: true, role: fence.role, changed: true };
}

/**
 * Read a bundled role prompt, cached until the file changes on disk.
 *
 * The hook runs on every request, so a bare readFileSync would put one stat +
 * read in front of every model call; caching on (size, mtimeMs) keeps an edit
 * to `prompts/*.md` live within a session — which is the whole point — without
 * paying for it each call. `roles` is a fixed allowlist because the role comes
 * out of a text fence: without it, a crafted marker turns this into a path
 * read.
 *
 * @param {{readFile: (role: string) => string, statKey: (role: string) => string, roles?: string[]}} io
 */
export function createPromptLoader({ readFile, statKey, roles = ["grunt", "drill"] }) {
  const allowed = new Set(roles);
  /** @type {Map<string, {key: string, body: string}>} */
  const cache = new Map();
  return (/** @type {string} */ role) => {
    if (!allowed.has(role)) return null;
    let key;
    try {
      key = statKey(role);
    } catch {
      return null;
    }
    const hit = cache.get(role);
    if (hit && hit.key === key) return hit.body;
    let body;
    try {
      body = readFile(role);
    } catch {
      return null;
    }
    cache.set(role, { key, body });
    return body;
  };
}
