// The squad roster as data: read the current squad out of the generated agent
// files, validate an edited roster, and diff the two.
//
// Why this exists. The generator used to take one declarative list — "here is
// the roster, prune everything else". Asked to ADD a model, the caller would
// pass the single new id and the pruner would delete the rest. The protocol was
// followed exactly and the squad was still wiped, because composing the right
// invocation was the caller's job and getting it wrong was silent and total.
//
// So the interaction became read-modify-write: dump the roster, edit the entry
// you mean, apply it back. Editing a structure is a far more reliable operation
// than assembling flags.
//
// Two properties make that safe, and neither is optional:
//
//   1. The roster is DERIVED from the agent files on every dump, never stored
//      alongside them. A stored manifest would be a second source of truth, and
//      it would desync the first time anyone touched the agent dir by hand.
//
//   2. Apply refuses to delete. Read-modify-write only protects while the
//      caller actually modifies; one that regenerates the roster from memory
//      reintroduces the wipe in a new wrapper. The guard, not the format, is
//      what makes destruction require intent.
//
// SHAPE. One map per role, keyed by model id, mirroring the files on disk:
//
//   { "grunts": { "zai-coding-plan/glm-5.3": { "variant": "high" } },
//     "drills": { "anthropic/claude-opus-5": { "variant": "max" } } }
//
// This replaced a flat model list carrying a `roles` array, for two reasons
// worth keeping written down. First, one entry per MODEL forced one `variant`
// per model, so "grunt at high, drill at max" was inexpressible — and a drill,
// whose job is the harder cognitive one, is exactly where you would want to
// spend more reasoning. Second, `roles: ["grunt"]` needed the rule "omitting it
// means both", which had to be explained in three places; here an agent either
// appears in a role map or it does not, and there is no rule to misread.

/** Roster key -> opencode agent role. `grunts` reads better than `grunt`. */
export const ROLE_KEYS = /** @type {const} */ ({ grunts: "grunt", drills: "drill" });

/**
 * Per-agent fields the roster owns.
 *
 * Deliberately NOT exposed, though opencode's agent schema has them:
 * `permission` (the read-only contract of a drill is a safety property, not a
 * preference), `mode`/`hidden`/`color` (ours), and `temperature`/`top_p`/
 * `options` — nobody has needed those, and `options` in particular can override
 * the variant silently, which is the opposite of what this roster is for.
 */
const AGENT_KEYS = new Set(["variant", "description", "notes", "steps", "disable"]);

/**
 * Fences the roster-supplied `notes` inside the generated prompt body so a dump
 * can read them back. Without a marker the extra instructions would be
 * indistinguishable from the bundled role prompt, and the round trip — which is
 * what makes read-modify-write trustworthy — would quietly lose them.
 */
export const NOTES_OPEN = "<!-- squad:notes -->";
export const NOTES_CLOSE = "<!-- /squad:notes -->";

/**
 * Read one generated agent file back into a roster entry.
 *
 * A narrow line-scan of the frontmatter rather than a YAML parse: these files
 * are written by `agentMarkdown()`, so the shape is known, and a parser would
 * be a dependency bought for nothing.
 *
 * @param {string} text  contents of a `grunt-*.md` / `drill-*.md`
 * @returns {{modelId?: string, entry: Record<string, any>}}
 */
export function parseAgentFile(text) {
  const src = String(text);
  /** @type {Record<string, any>} */
  const entry = {};
  let modelId;
  const lines = src.split("\n");
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "---") break;
      const m = line.match(/^([a-z_]+):\s*(\S.*?)\s*$/);
      if (!m) continue;
      const [, key, value] = m;
      if (key === "model") modelId = value;
      else if (key === "variant") entry.variant = value;
      else if (key === "description") entry.description = value;
      else if (key === "steps") entry.steps = Number(value);
      else if (key === "disable" && value === "true") entry.disable = true;
    }
  }
  const open = src.indexOf(NOTES_OPEN);
  const close = src.indexOf(NOTES_CLOSE);
  if (open !== -1 && close > open) {
    const notes = src.slice(open + NOTES_OPEN.length, close).trim();
    if (notes) entry.notes = notes;
  }
  return { modelId, entry };
}

/**
 * Fold per-file entries into the roster tree.
 *
 * `description` is dropped when it matches the role's default, so a dump shows
 * only what someone actually chose. That matters more than it sounds: the
 * description is what the orchestrator reads in its subagent inventory when it
 * picks who to dispatch, and today every grunt carries the same generic
 * sentence — ten copies of a line that says nothing about which model to pick.
 * Keeping defaults out of the dump is what makes a real one visible.
 *
 * @param {Array<{role: string, modelId?: string, entry: Record<string, any>}>} files
 * @param {Record<string, string>} [defaultDescriptions]  role -> default description
 * @returns {{roster: Record<string, Record<string, any>>, conflicts: string[]}}
 */
export function buildRoster(files, defaultDescriptions = {}) {
  /** @type {Record<string, Record<string, any>>} */
  const roster = { grunts: {}, drills: {} };
  const conflicts = [];
  for (const f of files) {
    if (!f?.modelId) continue;
    const key = f.role === "drill" ? "drills" : "grunts";
    if (roster[key][f.modelId]) {
      conflicts.push(`${f.role} ${f.modelId}: more than one file claims it; keeping the first`);
      continue;
    }
    const entry = { ...f.entry };
    if (entry.description && entry.description === defaultDescriptions[f.role]) {
      delete entry.description;
    }
    roster[key][f.modelId] = entry;
  }
  for (const key of Object.keys(roster)) {
    roster[key] = Object.fromEntries(
      Object.entries(roster[key]).sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  return { roster, conflicts };
}

/**
 * Validate an edited roster. Hand-rolled rather than schema-driven: the shape
 * is shallow, and a validator dependency in a scaffolder earns less than it
 * costs. Reports every problem at once — someone fixing an edited document
 * should not discover the mistakes one run at a time.
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
  for (const key of Object.keys(obj)) {
    if (!(key in ROLE_KEYS)) {
      errors.push(`unknown top-level key "${key}" (expected ${Object.keys(ROLE_KEYS).join(", ")})`);
    }
  }
  for (const key of Object.keys(ROLE_KEYS)) {
    const map = obj[key];
    if (map === undefined) continue;
    if (typeof map !== "object" || map === null || Array.isArray(map)) {
      errors.push(`${key} must be an object keyed by model id`);
      continue;
    }
    for (const [modelId, raw] of Object.entries(map)) {
      const at = `${key}["${modelId}"]`;
      if (!/^[^/]+\/.+$/.test(modelId)) {
        errors.push(`${at}: "${modelId}" is not a provider/model id`);
      }
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        errors.push(`${at} must be an object (use {} for no overrides)`);
        continue;
      }
      const entry = /** @type {Record<string, unknown>} */ (raw);
      for (const k of Object.keys(entry)) {
        if (!AGENT_KEYS.has(k)) errors.push(`${at} has unknown key "${k}"`);
      }
      for (const k of ["variant", "description", "notes"]) {
        if (entry[k] !== undefined && (typeof entry[k] !== "string" || !String(entry[k]).trim())) {
          errors.push(`${at}.${k} must be a non-empty string when present`);
        }
      }
      if (entry.steps !== undefined && (!Number.isInteger(entry.steps) || entry.steps <= 0)) {
        errors.push(`${at}.steps must be a positive integer when present`);
      }
      if (entry.disable !== undefined && typeof entry.disable !== "boolean") {
        errors.push(`${at}.disable must be a boolean when present`);
      }
    }
  }
  return errors;
}

/** Flatten a roster tree to `"<role> <modelId>" -> entry`, for diffing. */
function flatten(roster) {
  const out = new Map();
  for (const [key, role] of Object.entries(ROLE_KEYS)) {
    for (const [modelId, entry] of Object.entries(roster?.[key] ?? {})) {
      out.set(`${role} ${modelId}`, entry ?? {});
    }
  }
  return out;
}

/**
 * Compare the roster on disk with the one being applied. The unit is the AGENT,
 * which is also the unit on disk — so `removed` is exactly the set of files that
 * would be deleted, and the guard has one thing to count.
 *
 * @param {Record<string, Record<string, any>>} current
 * @param {Record<string, Record<string, any>>} next
 * @returns {{added: string[], removed: string[], changed: string[], unchanged: string[]}}
 */
export function diffRoster(current, next) {
  const cur = flatten(current);
  const nxt = flatten(next);
  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];

  for (const [k, entry] of nxt) {
    const before = cur.get(k);
    if (!before) {
      added.push(k);
      continue;
    }
    const fields = [...AGENT_KEYS].filter(
      (f) => JSON.stringify(before[f] ?? null) !== JSON.stringify(entry[f] ?? null),
    );
    if (fields.length === 0) {
      unchanged.push(k);
      continue;
    }
    const detail = fields
      .map(
        (f) => `${f} ${JSON.stringify(before[f] ?? null)} -> ${JSON.stringify(entry[f] ?? null)}`,
      )
      .join("; ");
    changed.push(`${k}: ${detail}`);
  }
  for (const k of cur.keys()) if (!nxt.has(k)) removed.push(k);

  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
    unchanged: unchanged.sort(),
  };
}
