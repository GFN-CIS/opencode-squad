// Pure helpers for scaffolding per-model squad subagents — both grunts (workers)
// and drills (reviewers) — from one model list.
//
// opencode has no way to pass a model when dispatching via the `task` tool (its
// input is {description, prompt, subagent_type, ...} — no model). The only lever
// the orchestrator has is `subagent_type`. So to give it a choice of models we
// materialize one named agent per model per role; each shows up in the inventory
// with its model and is dispatched by name.

// Stable prefix that marks our generated files (as a YAML comment) so the
// generator can prune its own previous output without touching hand-authored
// agents. Detection uses this prefix (stable across renames); the full line
// below carries the current skill name for readability.
const GENERATED_MARKER_PREFIX = "generated-by: opencode-squad";
export const GENERATED_MARKER = `${GENERATED_MARKER_PREFIX} squad-draft`;
// Prune detection matches files from before the opencode-orchestrate -> squad
// rename too, so regenerating cleanly migrates older generated agents.
export const GENERATED_MARKER_DETECT = "generated-by: opencode-";

// Per-role config: name prefix, description, and YAML permission lines. grunt
// executes (edit/bash); drill reviews read-only (matches the bundled agents).
const ROLES = {
  grunt: {
    description: "Per-model grunt (worker) for the sarge PDCA cycle.",
    permission: ["  edit: allow", "  bash: allow", "  task:", "    '*': deny"],
  },
  drill: {
    description: "Per-model drill (reviewer) for the sarge PDCA cycle.",
    permission: ["  edit: deny", "  bash: deny", "  webfetch: allow", "  task:", "    '*': deny"],
  },
};

/**
 * Turn a `provider/model` id into a stable agent name for a role.
 * e.g. ("openai/gpt-5.5", "grunt") -> "grunt-openai-gpt-5-5",
 *      ("openai/gpt-5.5", "drill") -> "drill-openai-gpt-5-5".
 *
 * @param {string} modelId
 * @param {"grunt"|"drill"} [role]
 * @returns {string}
 */
export function slugForModel(modelId, role = "grunt") {
  const base = String(modelId)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${role}-${base}`;
}

/**
 * Render the agent markdown file for one role+model: YAML frontmatter (subagent,
 * the model, role permissions, hidden) + the role's prompt as body.
 *
 * `variant` selects the model's reasoning level. opencode builds a model's
 * variants from models.dev's `reasoning_options` (e.g. glm-5.3 publishes
 * `low|high|max`, claude-opus-5 `low|medium|high|xhigh|max`) and lowers the
 * chosen one into the provider's own parameter — `reasoning_effort` for
 * openai-compatible providers. Without a variant NO reasoning parameter is
 * sent, which for an openai-compatible model means its reasoning is bounded by
 * nothing but the output cap: measured on glm-5.3, 70% of the token budget went
 * to reasoning, with a tail to ~19k reasoning tokens in one turn, and two grunts
 * were truncated mid-thought at the 32k cap having emitted 2 and 9 tokens.
 * Anthropic models stay bounded without a variant because their server-side
 * adaptive default governs; openai-compatible ones have no such fallback.
 *
 * Setting a variant is therefore NOT a way to suppress reasoning — it is what
 * puts an unbounded reasoner under the same kind of governor Claude already has.
 *
 * An unknown variant is SILENTLY IGNORED by opencode (`if (!(agent.variant in
 * model.variants)) return undefined`), so a typo buys silence, not an error.
 * Only pass values from that model's own `reasoning_options`.
 *
 * @param {"grunt"|"drill"} role
 * @param {string} modelId  e.g. "anthropic/claude-opus-4-7"
 * @param {string} promptBody  contents of prompts/<role>.md
 * @param {{variant?: string}} [opts]
 * @returns {{slug:string, filename:string, content:string}}
 */
export function agentMarkdown(role, modelId, promptBody, opts = {}) {
  const cfg = ROLES[role];
  if (!cfg) throw new Error(`unknown role: ${role}`);
  const slug = slugForModel(modelId, role);
  const variant = opts.variant?.trim();
  const content = [
    "---",
    `# ${GENERATED_MARKER}`,
    `description: ${cfg.description}`,
    "mode: subagent",
    `model: ${modelId}`,
    // Only emitted when asked for: an absent `variant` leaves the model on its
    // provider default, which is the right behaviour for models that don't
    // publish reasoning options at all.
    ...(variant ? [`variant: ${variant}`] : []),
    "hidden: true",
    "permission:",
    ...cfg.permission,
    "---",
    "",
    promptBody.trim(),
    "",
  ].join("\n");
  return { slug, filename: `${slug}.md`, content };
}
