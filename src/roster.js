// The squad roster as data: read the current squad out of the generated agent
// files, validate an edited roster, and diff the two.
//
// Why this exists. The generator used to take one declarative list — "here is
// the roster, prune everything else". Asked to ADD a model, the caller would
// pass the single new id and the pruner would delete the rest. The protocol was
// followed exactly and the squad was still wiped, because composing the right
// invocation was the caller's job and getting it wrong was silent and total.
//
// So the interaction became read-modify-write: export the roster as JSON, edit
// the field you mean, apply it back. Editing a structure is a far more reliable
// operation than assembling flags.
//
// Two properties make that safe, and neither is optional:
//
//   1. The roster is DERIVED from the agent files on every export, never stored
//      alongside them. A stored manifest would be a second source of truth, and
//      it would desync the first time anyone touched the agent dir by hand.
//
//   2. Apply refuses to remove. Read-modify-write only protects while the
//      caller actually modifies; one that regenerates the roster from memory
//      reintroduces the wipe in a new wrapper. The guard, not the format, is
//      what makes destruction require intent — so removals need an explicit
//      opt-in and are reported by name before they happen.

/** Current roster schema version. Bumped only on a breaking shape change. */
export const ROSTER_VERSION = 1;

/**
 * JSON Schema for the roster document, served by `squad-draft.mjs --schema` so
 * the caller reads the shape instead of guessing it.
 *
 * `variant` is deliberately an open string rather than an enum: the valid
 * levels are per-model, published by models.dev as `reasoning_options`
 * (glm-5.3 has `low|high|max` and no `medium`; claude-opus-5 has
 * `low|medium|high|xhigh|max`). An enum here would be wrong for some model on
 * the day it shipped.
 */
export const ROSTER_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "opencode-squad roster",
  type: "object",
  required: ["version", "models"],
  additionalProperties: false,
  properties: {
    version: { const: ROSTER_VERSION },
    models: {
      type: "array",
      description: "One entry per model. Each yields a grunt and a drill agent.",
      items: {
        type: "object",
        required: ["id"],
        additionalProperties: false,
        properties: {
          id: {
            type: "string",
            description: 'opencode model id, e.g. "zai-coding-plan/glm-5.3".',
            pattern: "^[^/]+/.+$",
          },
          variant: {
            type: "string",
            description:
              "Reasoning level for this model. Must be one of that model's own " +
              "`reasoning_options` values in models.dev — opencode SILENTLY IGNORES " +
              "an unrecognized variant. Omit for models that publish none.",
            minLength: 1,
          },
        },
      },
    },
  },
};

/**
 * Pull the model id and reasoning variant out of a generated agent file's YAML
 * frontmatter. Deliberately a narrow line-scan rather than a YAML parse: these
 * files are written by `agentMarkdown()`, so the shape is known, and a real
 * parser would be a dependency bought for nothing.
 *
 * @param {string} text  contents of a `grunt-*.md` / `drill-*.md`
 * @returns {{modelId?: string, variant?: string}}
 */
export function parseAgentFrontmatter(text) {
  const out = /** @type {{modelId?: string, variant?: string}} */ ({});
  const lines = String(text).split("\n");
  if (lines[0]?.trim() !== "---") return out;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") break;
    const model = line.match(/^model:\s*(\S.*?)\s*$/);
    if (model) out.modelId = model[1];
    const variant = line.match(/^variant:\s*(\S.*?)\s*$/);
    if (variant) out.variant = variant[1];
  }
  return out;
}

/**
 * Fold the per-role agent entries into one roster. A model has two files (a
 * grunt and a drill); they are one roster entry.
 *
 * A model whose two files disagree on the variant is reported rather than
 * silently resolved — that only happens when something wrote them out of band,
 * and quietly picking a side would hide it.
 *
 * @param {Array<{modelId: string, variant?: string}>} entries
 * @returns {{roster: {version: number, models: Array<{id: string, variant?: string}>}, conflicts: string[]}}
 */
export function buildRoster(entries) {
  /** @type {Map<string, {id: string, variant?: string}>} */
  const byId = new Map();
  const conflicts = [];
  for (const entry of entries) {
    if (!entry?.modelId) continue;
    const existing = byId.get(entry.modelId);
    if (!existing) {
      byId.set(
        entry.modelId,
        entry.variant ? { id: entry.modelId, variant: entry.variant } : { id: entry.modelId },
      );
      continue;
    }
    if ((existing.variant ?? "") !== (entry.variant ?? "")) {
      conflicts.push(
        `${entry.modelId}: its agents disagree on variant (${existing.variant ?? "none"} vs ${entry.variant ?? "none"}); keeping ${existing.variant ?? "none"}`,
      );
    }
  }
  const models = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { roster: { version: ROSTER_VERSION, models }, conflicts };
}

/**
 * Validate an edited roster document. Hand-rolled rather than schema-driven:
 * the shape is four fields deep, and a validator dependency in a scaffolder
 * earns less than it costs.
 *
 * Returns every problem at once — a caller fixing a hand-edited file should not
 * have to discover the mistakes one run at a time.
 *
 * @param {unknown} doc
 * @returns {string[]}  empty when valid
 */
export function validateRoster(doc) {
  const errors = [];
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return ["roster must be a JSON object"];
  }
  const obj = /** @type {Record<string, unknown>} */ (doc);
  if (obj.version !== ROSTER_VERSION) {
    errors.push(`version must be ${ROSTER_VERSION} (got ${JSON.stringify(obj.version)})`);
  }
  for (const key of Object.keys(obj)) {
    if (key !== "version" && key !== "models") errors.push(`unknown top-level key "${key}"`);
  }
  if (!Array.isArray(obj.models)) {
    errors.push("models must be an array");
    return errors;
  }
  const seen = new Set();
  obj.models.forEach((raw, i) => {
    const at = `models[${i}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      errors.push(`${at} must be an object`);
      return;
    }
    const entry = /** @type {Record<string, unknown>} */ (raw);
    for (const key of Object.keys(entry)) {
      if (key !== "id" && key !== "variant") errors.push(`${at} has unknown key "${key}"`);
    }
    if (typeof entry.id !== "string" || !entry.id.trim()) {
      errors.push(`${at}.id must be a non-empty string`);
    } else {
      if (!/^[^/]+\/.+$/.test(entry.id.trim())) {
        errors.push(`${at}.id "${entry.id}" is not a provider/model id`);
      }
      if (seen.has(entry.id.trim())) errors.push(`${at}.id "${entry.id}" is listed twice`);
      seen.add(entry.id.trim());
    }
    if (
      entry.variant !== undefined &&
      (typeof entry.variant !== "string" || !entry.variant.trim())
    ) {
      errors.push(`${at}.variant must be a non-empty string when present`);
    }
  });
  return errors;
}

/**
 * Compare the roster on disk with the one being applied.
 *
 * `changed` is a variant edit on a model that stays — it rewrites two files and
 * removes nothing, so it is never gated. Only `removed` is destructive.
 *
 * @param {{models: Array<{id: string, variant?: string}>}} current
 * @param {{models: Array<{id: string, variant?: string}>}} next
 * @returns {{added: string[], removed: string[], changed: string[], unchanged: string[]}}
 */
export function diffRoster(current, next) {
  const cur = new Map((current?.models ?? []).map((m) => [m.id, m.variant ?? ""]));
  const nxt = new Map((next?.models ?? []).map((m) => [m.id, m.variant ?? ""]));
  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];
  for (const [id, variant] of nxt) {
    if (!cur.has(id)) {
      added.push(variant ? `${id}@${variant}` : id);
      continue;
    }
    const before = cur.get(id) ?? "";
    if (before === variant) unchanged.push(id);
    else changed.push(`${id}: ${before || "no variant"} -> ${variant || "no variant"}`);
  }
  for (const id of cur.keys()) if (!nxt.has(id)) removed.push(id);
  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
    unchanged: unchanged.sort(),
  };
}
