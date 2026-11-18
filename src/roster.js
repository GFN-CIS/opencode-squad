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

import { readFrontmatter } from "./frontmatter.js";

/** Roster key -> opencode agent role. `grunts` reads better than `grunt`. */
export const ROLE_KEYS = /** @type {const} */ ({ grunts: "grunt", drills: "drill" });

// Per-agent fields the roster owns are defined once, in the squad_patch
// schema (src/roster-schema.js). Deliberately NOT exposed, though opencode's
// agent schema has them: `permission`/`permissions` (the read-only contract of
// a drill is a safety property, not a preference), `mode`/`hidden`/`color`
// (ours), and `temperature`/`top_p`/`options` — nobody has needed those, and
// `options` in particular can override the variant silently, which is the
// opposite of what this roster is for.

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
 * The frontmatter goes through the YAML parser (src/frontmatter.js) — the same
 * reading OpenCode gives the file — so a quoted `model: "p/m#high"` yields
 * `p/m` + `high`, not a stray quote. Legacy fields are still understood:
 * a separate `variant:` key and `disable:` from V1 files. A file without a
 * frontmatter block, or with one that does not parse, yields no model: it is
 * not a squad agent this roster can represent.
 *
 * @param {string} text  contents of a `grunt-*.md` / `drill-*.md`
 * @returns {{modelId?: string, entry: Record<string, any>}}
 */
export function parseAgentFile(text) {
  const src = String(text);
  /** @type {Record<string, any>} */
  const entry = {};
  let modelId;
  const fm = readFrontmatter(src);
  if (fm.state === "ok") {
    const { model, variant, steps, disable, disabled } = fm.fields;
    if (typeof model === "string" && model.trim()) {
      const [id, suffix] = model.trim().split("#");
      modelId = id.trim() || undefined;
      if (suffix?.trim()) entry.variant = suffix.trim();
    }
    if (typeof variant === "string" && variant.trim()) entry.variant = variant.trim();
    if (steps !== undefined && steps !== null) entry.steps = Number(steps);
    if ([disable, disabled].some((v) => v === true || v === "true")) entry.disable = true;
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
 * `description` is never read into the roster (parseAgentFile skips it): the
 * plugin derives it from model_data.json. A dump that carried it would invite
 * the orchestrator to pass it back — and to "improve" it.
 *
 * @param {Array<{role: string, modelId?: string, entry: Record<string, any>}>} files
 * @returns {{roster: Record<string, Record<string, any>>, conflicts: string[]}}
 */
export function buildRoster(files) {
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
    roster[key][f.modelId] = entry;
  }
  for (const key of Object.keys(roster)) {
    roster[key] = Object.fromEntries(
      Object.entries(roster[key]).sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  return { roster, conflicts };
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
    // Every field either side carries: entries are validated against the
    // roster schema, and parseAgentFile reads back only those fields.
    const fields = [...new Set([...Object.keys(before), ...Object.keys(entry ?? {})])]
      .sort()
      .filter((f) => JSON.stringify(before[f] ?? null) !== JSON.stringify(entry[f] ?? null));
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
