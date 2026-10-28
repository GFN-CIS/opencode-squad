import { placeholderBody, wrapPrompt } from "./prompt-inject.js";
import { NOTES_CLOSE, NOTES_OPEN } from "./roster.js";

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

const DRILL_SHELL_COMMANDS = [
  "git log",
  "git show",
  "git diff",
  "git blame",
  "git status",
  "git grep",
  "git ls-files",
  "git ls-tree",
  "git cat-file",
  "git rev-parse",
  "git merge-base",
  "git describe",
  "git shortlog",
  "gh pr view",
  "gh pr diff",
  "gh pr list",
  "gh pr checks",
  "gh issue view",
  "gh issue list",
  "gh run view",
  "gh run list",
  "gh repo view",
  "gh release view",
  "gh release list",
  "glab mr view",
  "glab mr diff",
  "glab mr list",
  "glab issue view",
  "glab issue list",
  "glab ci list",
  "glab ci get",
  "glab repo view",
  "head",
  "tail",
  "wc",
  "grep",
  "sort",
  "uniq",
  "cut",
];

// Grunts keep their V1 policy; V2 drills override the base allow-all, including
// MCP and Code Mode. Unknown hosts keep the legacy no-shell drill policy.
const ROLES = {
  grunt: {
    description: "Per-model grunt (worker) for the sarge PDCA cycle.",
    permission: ["  edit: allow", "  bash: allow", "  task:", "    '*': deny"],
  },
  drill: {
    description: "Per-model drill (reviewer) for the sarge PDCA cycle.",
    permission: ["  edit: deny", "  bash: deny", "  webfetch: allow", "  task:", "    '*': deny"],
    permissions: [
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "read", resource: "*.env", effect: "ask" },
      { action: "read", resource: "*.env.*", effect: "ask" },
      { action: "read", resource: "*.env.example", effect: "allow" },
      // external_directory: reads outside the project (grunt handoffs in /tmp,
      // worktrees); edit stays denied, so this grants no write.
      ...["glob", "grep", "list", "skill", "webfetch", "websearch", "external_directory"].map(
        (action) => ({
          action,
          resource: "*",
          effect: "allow",
        }),
      ),
      { action: "shell", resource: "*", effect: "deny" },
      ...DRILL_SHELL_COMMANDS.map((command) => ({
        action: "shell",
        resource: `${command} *`,
        effect: "allow",
      })),
      // Last match wins: git diff/log --output can write even during inspection.
      { action: "shell", resource: "*--output*", effect: "deny" },
      { action: "shell", resource: "sort *-o*", effect: "deny" },
      { action: "shell", resource: "*>*", effect: "deny" },
    ],
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
 * Render the agent markdown file for one role+model.
 *
 * `variant` selects the model's reasoning level. opencode builds a model's
 * variants from models.dev's `reasoning_options` (glm-5.3 publishes
 * `low|high|max`, claude-opus-5 `low|medium|high|xhigh|max`) and lowers the
 * chosen one into the provider's own parameter — `reasoning_effort` for
 * openai-compatible providers. Without a variant NO reasoning parameter is
 * sent, which for an openai-compatible model means its reasoning is bounded by
 * nothing but the output cap: measured on glm-5.3, 70% of the token budget went
 * to reasoning, with a tail to ~19k reasoning tokens in one turn, and two grunts
 * were truncated mid-thought at the 32k cap having emitted 2 and 9 tokens.
 * A variant is a HINT ABOUT DEPTH, not a token budget, and it does not stop a
 * turn from hitting the cap: on 2026-09-02/03 a glm-5.3 grunt and two
 * claude-sonnet-5 grunts were truncated at 32k WITH `variant: high` set. What it
 * does change is how often that happens — with the variant, glm-5.3 ran 83 turns
 * in a day with none. Treat it as mitigation, not a fix; the fix is the cap.
 *
 * Nor is Anthropic immune, contrary to what this comment used to claim: sonnet-5
 * burned the whole 32k on reasoning and emitted 0 output tokens. The earlier
 * conclusion came from per-message reasoning LENGTHS on another machine and did
 * not survive contact with truncation data.
 *
 * An unknown variant is SILENTLY IGNORED by opencode (`if (!(agent.variant in
 * model.variants)) return undefined`), so a typo buys silence, not an error.
 *
 * `description` is what the orchestrator reads in its subagent inventory when
 * choosing who to dispatch, so a per-model one ("cheap, mechanical edits" vs
 * "strong analysis") is the difference between a routing signal and ten copies
 * of the same sentence. Defaults to the role's generic line.
 *
 * `notes` are extra instructions appended to the role prompt, fenced by markers
 * so a dump can read them back — the round trip is what makes the roster
 * trustworthy to edit.
 *
 * The ROLE PROMPT ITSELF is not written here. The file gets a fenced
 * placeholder, and the plugin swaps in the current `prompts/<role>.md` on every
 * request (src/prompt-inject.js) — so a prompt edit is live without
 * regenerating the squad, and the file never carries a second, staler copy of
 * a text it does not own.
 *
 * @param {"grunt"|"drill"} role
 * @param {string} modelId  e.g. "anthropic/claude-opus-4-7"
 * @param {{variant?: string, description?: string, notes?: string, steps?: number, disable?: boolean}} [opts]
 * @param {{hostGeneration?: 1|2}} [host] Host-owned, never a roster override.
 * @returns {{slug:string, filename:string, content:string}}
 */
export function agentMarkdown(role, modelId, opts = {}, { hostGeneration = 1 } = {}) {
  const cfg = ROLES[role];
  if (!cfg) throw new Error(`unknown role: ${role}`);
  const native = hostGeneration === 2 && !!cfg.permissions;
  const slug = slugForModel(modelId, role);
  const variant = opts.variant?.trim();
  const description = opts.description?.trim() || cfg.description;
  const notes = opts.notes?.trim();
  // Roster `notes` sit OUTSIDE the fence: they belong to this agent, and the
  // fence is replaced wholesale on every request.
  const fenced = wrapPrompt(role, placeholderBody(role));
  const body = notes ? `${fenced}\n\n${NOTES_OPEN}\n${notes}\n${NOTES_CLOSE}` : fenced;
  const content = [
    "---",
    `# ${GENERATED_MARKER}`,
    `description: ${description}`,
    "mode: subagent",
    `model: ${modelId}${native && variant ? `#${variant}` : ""}`,
    // Each emitted only when asked for: an absent key leaves opencode on its
    // own default, which is the right behaviour for a model that publishes no
    // reasoning options, or an agent nobody has capped.
    ...(!native && variant ? [`variant: ${variant}`] : []),
    ...(typeof opts.steps === "number" ? [`steps: ${opts.steps}`] : []),
    ...(opts.disable ? [native ? "disabled: true" : "disable: true"] : []),
    "hidden: true",
    ...(native
      ? ["permissions:", ...cfg.permissions.map((rule) => `  - ${JSON.stringify(rule)}`)]
      : ["permission:", ...cfg.permission]),
    "---",
    "",
    body,
    "",
  ].join("\n");
  return { slug, filename: `${slug}.md`, content };
}

/** The generic per-role description, used when the roster names none. */
export function defaultDescriptions() {
  return Object.fromEntries(Object.entries(ROLES).map(([role, cfg]) => [role, cfg.description]));
}
