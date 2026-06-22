// Pure helpers for generating per-model grunt (worker) subagent definitions.
//
// opencode has no way to pass a model when dispatching via the `task` tool
// (its input is {description, prompt, subagent_type, ...} — no model). The only
// lever the orchestrator has is `subagent_type`. So to give it a choice of
// models we materialize one named grunt agent per model; each shows up in the
// inventory with its model and is dispatched by name.

// Stable prefix that marks our generated files (as a YAML comment) so the
// generator can prune its own previous output without touching hand-authored
// agents. Detection uses this prefix (stable across renames); the full line
// below carries the current skill name for readability.
export const GENERATED_MARKER_PREFIX = "generated-by: opencode-squad";
export const GENERATED_MARKER = `${GENERATED_MARKER_PREFIX} draft-grunts`;
// Prune detection matches files from before the opencode-orchestrate -> squad
// rename too, so regenerating cleanly migrates older generated agents.
export const GENERATED_MARKER_DETECT = "generated-by: opencode-";

// Per-model grunt agent name prefix. Legacy "worker-" files are still pruned on
// regeneration (see the generator) so the rename migrates cleanly.
export const GRUNT_PREFIX = "grunt-";

/**
 * Turn a `provider/model` id into a stable agent name.
 * e.g. "openai/gpt-5.5" -> "grunt-openai-gpt-5-5",
 *      "google/gemini-3.1-pro-preview-customtools"
 *        -> "grunt-google-gemini-3-1-pro-preview-customtools".
 *
 * @param {string} modelId
 * @returns {string}
 */
export function slugForModel(modelId) {
  const base = String(modelId)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${GRUNT_PREFIX}${base}`;
}

/**
 * Render the agent markdown file for one model: YAML frontmatter (subagent,
 * the model, grunt permissions, hidden) + the shared grunt prompt as body.
 *
 * @param {string} modelId  e.g. "anthropic/claude-opus-4-7"
 * @param {string} promptBody  contents of prompts/grunt.md
 * @returns {{slug:string, filename:string, content:string}}
 */
export function workerAgentMarkdown(modelId, promptBody) {
  const slug = slugForModel(modelId);
  const content = [
    "---",
    `# ${GENERATED_MARKER}`,
    // Terse on purpose: the inventory already shows the model separately, and
    // N per-model grunts with a long description bloat the injected context.
    "description: Per-model grunt for the sarge PDCA cycle.",
    "mode: subagent",
    `model: ${modelId}`,
    "hidden: true",
    "permission:",
    "  edit: allow",
    "  bash: allow",
    "  task:",
    "    '*': deny",
    "---",
    "",
    promptBody.trim(),
    "",
  ].join("\n");
  return { slug, filename: `${slug}.md`, content };
}
