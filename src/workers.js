// Pure helpers for generating per-model worker subagent definitions.
//
// opencode has no way to pass a model when dispatching via the `task` tool
// (its input is {description, prompt, subagent_type, ...} — no model). The only
// lever the orchestrator has is `subagent_type`. So to give it a choice of
// models we materialize one named worker agent per model; each shows up in the
// inventory with its model and is dispatched by name.

// Marker placed in every generated file (as a YAML comment) so the generator
// can prune its own previous output without touching hand-authored agents.
export const GENERATED_MARKER =
  "generated-by: opencode-orchestrate generating-model-workers";

/**
 * Turn a `provider/model` id into a stable agent name.
 * e.g. "openai/gpt-5.5" -> "worker-openai-gpt-5-5",
 *      "google/gemini-3.1-pro-preview-customtools"
 *        -> "worker-google-gemini-3-1-pro-preview-customtools".
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
  return `worker-${base}`;
}

/**
 * Render the agent markdown file for one model: YAML frontmatter (subagent,
 * the model, worker permissions, hidden) + the shared worker prompt as body.
 *
 * @param {string} modelId  e.g. "anthropic/claude-opus-4-7"
 * @param {string} promptBody  contents of prompts/worker.md
 * @returns {{slug:string, filename:string, content:string}}
 */
export function workerAgentMarkdown(modelId, promptBody) {
  const slug = slugForModel(modelId);
  const content = [
    "---",
    `# ${GENERATED_MARKER}`,
    // Terse on purpose: the inventory already shows the model separately, and
    // N per-model workers with a long description bloat the injected context.
    "description: Per-model worker for orchestrator-driven PDCA.",
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
