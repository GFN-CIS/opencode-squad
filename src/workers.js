// Pure helpers for scaffolding per-model squad subagents — both grunts (workers)
// and drills (reviewers) — from one model list.
//
// The `subagent` tool dispatches by agent id rather than by model. To give the
// orchestrator a choice of models we
// materialize one named agent per model per role; each shows up in the inventory
// with its model and is dispatched by name.

// Versions before #85 wrote each agent as a file marked, on its first
// frontmatter line, with "# generated-by: opencode-squad ..." (or
// "opencode-orchestrate" before the rename). The marker now only identifies
// those files for the one-time import (src/squad-apply.js readLegacySquad);
// another generator's "opencode-<x>" is not ours.
const GENERATED_MARKER_DETECT = "generated-by: opencode-(?:squad|orchestrate)(?=[ \\t\\r\\n]|$)";
// Every version that wrote agent files put the marker on the first line of
// the frontmatter, so that is the only place it counts: a hand-authored agent
// whose prompt quotes the marker is still the user's. No closing fence is
// required — a header cut off mid-way is ours, just damaged. An optional BOM
// and CRLF line endings survive an editor round trip.
const GENERATED_HEADER_RE = new RegExp(
  `^\\uFEFF?---[ \\t]*\\r?\\n#[ \\t]*${GENERATED_MARKER_DETECT}`,
);

/**
 * Whether an agent file was written by this plugin (or its pre-rename self).
 *
 * @param {string} text  the file's full content
 */
export function isGeneratedAgent(text) {
  return GENERATED_HEADER_RE.test(text);
}

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

// Drills override the base allow-all, including MCP and Code Mode.
const ROLES = {
  grunt: {
    description: "Per-model grunt (worker) for the sarge PDCA cycle.",
    permissions: [
      { action: "edit", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "allow" },
      { action: "subagent", resource: "*", effect: "deny" },
    ],
  },
  drill: {
    description: "Per-model drill (reviewer) for the sarge PDCA cycle.",
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
 * The permission rules a squad role adds to its agent. The plugin appends
 * them after the user's global rules (src/squad-agents.js), so with the host's
 * last-match evaluation they decide: a drill stays read-only whatever the
 * global config allows.
 *
 * @param {"grunt"|"drill"} role
 * @returns {Array<{action: string, resource: string, effect: string}>}
 */
export function roleRules(role) {
  const cfg = ROLES[role];
  if (!cfg) throw new Error(`unknown role: ${role}`);
  return cfg.permissions.map((rule) => ({ ...rule }));
}

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
 * The squad role a runtime agent id belongs to (`grunt-…` / `drill-…`, as
 * slugForModel names them), or null for any other agent. Legacy `worker-`
 * FILES are a disk-migration concern (src/squad-apply.js), not a runtime name.
 *
 * @param {unknown} name
 * @returns {"grunt"|"drill"|null}
 */
export function squadRoleOf(name) {
  const m = /^(grunt|drill)-/.exec(typeof name === "string" ? name : "");
  return m ? /** @type {"grunt"|"drill"} */ (m[1]) : null;
}

/**
 * The agent's description, derived from what the user wrote down — never from
 * benchmarks, which squad_metrics serves live, and never composed by the
 * orchestrator: asked to "refresh descriptions", sarge invented capability
 * blurbs ("strongest coder", "1M ctx") that were wrong within a week.
 *
 * What goes in is exactly what the user owns: the `info` rules from
 * model_data.json — provider-wide and per-model, binding routing rules such as
 * "no secrets" — and how the provider is paid for. Without either, the role's
 * generic line.
 *
 * `rules` are the provider's and the model's `info`, in that order.
 *
 * @param {"grunt"|"drill"} role
 * @param {{rules?: string[], billing?: {api: true} | {api: false, plan: string|null} | null}} [facts]
 * @returns {string}
 */
export function describeAgent(role, { rules = [], billing } = {}) {
  const cfg = ROLES[role];
  if (!cfg) throw new Error(`unknown role: ${role}`);
  const parts = [cfg.description];
  for (const rule of rules) {
    const r = String(rule).trim().replace(/\s+/g, " ");
    if (r) parts.push(`Owner rule: ${/[.!?]$/.test(r) ? r : `${r}.`}`);
  }
  if (billing) {
    parts.push(
      billing.api
        ? "Billing: metered API."
        : `Billing: subscription${billing.plan ? ` (${billing.plan})` : ""}.`,
    );
  }
  return parts.join(" ");
}

/** The generic per-role description, used when the roster names none. */
export function defaultDescriptions() {
  return Object.fromEntries(Object.entries(ROLES).map(([role, cfg]) => [role, cfg.description]));
}
