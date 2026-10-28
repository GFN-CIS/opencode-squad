// Text, variant reporting and validation for the squad_* tools.
// Input JSON Schemas read their wording from here.

/** Tool descriptions, keyed by tool name. */
export const TOOL_DESCRIPTIONS = {
  squad_compact:
    "Compact a subagent session BEFORE reusing it for a new, unrelated task: replaces its " +
    "history with a summary, so the next dispatch re-reads a small context instead of the " +
    "whole transcript. Use when you are about to send a LONG task down a session whose " +
    "context is already large and mostly irrelevant to it — the size is in that session's " +
    "last [CACHE STATUS] line. Not free: one full pass of the summarising model over the " +
    "history, and the session's provider cache goes cold afterwards, so it pays off only " +
    "when several turns follow. If the old history is worthless to the new task, a FRESH " +
    "session is cheaper than compacting. opencode's own auto-compaction fires only at the " +
    "context limit, which is far later than the moment this is for. The summarising " +
    "model is chosen by OpenCode 2's compaction settings — this tool cannot pick one.",
  squad_dump:
    "Read the current squad roster: every generated agent, grouped as `grunts` and " +
    "`drills` and keyed by model id, with its per-agent settings. ALWAYS call this " +
    "before squad_patch — the roster is a document you edit, not one you retype. " +
    "Returns JSON.",
  squad_patch:
    "Write the squad roster: one agent per entry under `grunts` / `drills`, keyed by " +
    "model id. This is the COMPLETE intended squad, not a delta — an agent absent from " +
    "it is DELETED, so start from squad_dump and edit that. Deleting an agent the user " +
    "did not ask you to delete is refused, not performed.",
};

/** Argument descriptions, keyed by argument (agent-entry fields under `agent.*`). */
export const ARG_DESCRIPTIONS = {
  "agent.variant":
    "Reasoning level. Must be one of THIS model's own `reasoning_options` values in " +
    "models.dev (glm-5.3: low|high|max; claude-opus-5: low|medium|high|xhigh|max) — " +
    "opencode silently ignores an unrecognized one, so a typo buys silence rather than " +
    "an error. Omit for models that publish no reasoning options. Setting it does not " +
    "suppress reasoning: it bounds a reasoner otherwise limited only by the output " +
    "cap. Per AGENT, so a drill may think harder than the grunt on the same model.",
  "agent.description":
    "What this agent is for, in one line. The orchestrator reads exactly this in its " +
    "subagent inventory when choosing who to dispatch, so make it say WHEN to pick " +
    "this model — 'cheap, mechanical edits', 'strong analysis, slow'. Omit to keep the " +
    "generic role default, which carries no routing signal at all.",
  "agent.notes":
    "Extra instructions appended to this agent's prompt only — per-model quirks and " +
    "workarounds. Round-trips through squad_dump.",
  "agent.steps": "Max agentic iterations before opencode forces a text-only response.",
  "agent.disable":
    "Park this agent without deleting it: it stops being dispatchable but its settings " +
    "survive. Prefer this over deleting an agent you may want back.",
  "compact.task_id": "The subagent session to compact — the task_id from its [CACHE STATUS] line.",
  "dump.directory":
    "Agent directory to read. Defaults to the global ~/.config/opencode/agent " +
    "(or $XDG_CONFIG_HOME/opencode/agent). " +
    "Pass a project's .opencode/agent to scope the squad to one project.",
  "patch.grunts": "Executors, keyed by model id. `{}` is a valid entry: role defaults.",
  "patch.drills":
    "Reviewers, keyed by model id. A drill's verdict is what the orchestrator acts " +
    "on, so give one only to a model that can actually review — a weak reviewer " +
    "rubber-stamps the work or invents faults, and both are worse than no review " +
    "because they launder a bad change as an approved one. Cheap and small " +
    "models belong in `grunts` alone.",
  "patch.allow_remove":
    "Permit deleting agents present in the current squad but absent from this " +
    "roster. Pass true ONLY when the user asked for that deletion — never to " +
    "get past the refusal.",
  "patch.directory":
    "Agent directory to write. Defaults to the global ~/.config/opencode/agent " +
    "(or $XDG_CONFIG_HOME/opencode/agent).",
};

/**
 * A grunt or drill calling a roster-changing or history-rewriting tool. Those
 * are the orchestrator's calls: a drill is read-only by contract, and a grunt
 * rewriting the squad mid-task outlives the session that did it.
 *
 * @param {unknown} agent the calling agent's id
 */
export function isSubagentCaller(agent) {
  return /^(?:grunt|drill)-/.test(typeof agent === "string" ? agent : "");
}

/**
 * The "variants opencode accepts" tail of squad_dump's output.
 *
 * @param {Record<string, string[]> | null} variantMap null when it could not be read
 * @param {{grunts?: Record<string, unknown>, drills?: Record<string, unknown>}} roster
 * @returns {string}
 */
export function formatVariantLines(variantMap, roster) {
  const ids = new Set([...Object.keys(roster.grunts ?? {}), ...Object.keys(roster.drills ?? {})]);
  if (variantMap === null) {
    return (
      "\n\nAccepted variants: could not be read from opencode — treat as UNKNOWN and " +
      "leave variants alone rather than guessing."
    );
  }
  if (ids.size === 0) return "";
  const lines = [...ids].sort().map((id) => {
    const v = variantMap[id];
    if (v === undefined) return `  ${id}: unknown (model not in this install)`;
    return `  ${id}: ${v.length ? v.join(" | ") : "(none — leave variant unset)"}`;
  });
  return (
    "\n\nVariants opencode accepts (authoritative — do not guess, and do not derive\n" +
    `these from models.dev):\n${lines.join("\n")}`
  );
}

/**
 * Variant errors for squad_patch. A variant opencode does not recognize is
 * DROPPED by it without any error, so a typo would otherwise land as a silently
 * ineffective config. Only checked when the lookup worked: our inability to
 * check must not block a legitimate edit.
 *
 * @param {{grunts?: Record<string, {variant?: string}>, drills?: Record<string, {variant?: string}>}} roster
 * @param {Record<string, string[]> | null | undefined} variantMap
 * @returns {string[]}
 */
export function validateVariants(roster, variantMap) {
  if (!variantMap) return [];
  const errors = [];
  for (const [key, map] of Object.entries({ grunts: roster.grunts, drills: roster.drills })) {
    for (const [id, entry] of Object.entries(map ?? {})) {
      const want = entry?.variant;
      if (!want) continue;
      const accepted = variantMap[id];
      if (accepted === undefined) continue; // model not in this install
      if (!accepted.includes(want)) {
        errors.push(
          `${key}["${id}"].variant "${want}" is not accepted by opencode for this ` +
            `model — it would be ignored silently. Accepted: ` +
            `${accepted.length ? accepted.join(" | ") : "(none: leave it unset)"}`,
        );
      }
    }
  }
  return errors;
}
