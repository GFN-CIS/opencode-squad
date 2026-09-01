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

/** The two roles a model can be materialized as, in file order. */
export const ALL_ROLES = ["grunt", "drill"];

/**
 * Which roles an entry asks for, defaulting to both.
 *
 * Both is the safe default because it is what OMITTING the field means, and
 * omission must never delete anything — narrowing an entry to one role is an
 * edit you have to actually type.
 *
 * @param {unknown} roles
 * @returns {string[]}
 */
export function rolesOf(roles) {
  if (!Array.isArray(roles) || roles.length === 0) return [...ALL_ROLES];
  return ALL_ROLES.filter((r) => roles.includes(r));
}

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
 * Fold the per-role agent entries into one roster. A model normally has two
 * files (a grunt and a drill), and they are one entry.
 *
 * `roles` is emitted only when it is NOT the default pair — a model that exists
 * as a grunt alone comes back as `roles: ["grunt"]`, which is also how you ask
 * for that. Not every model deserves a drill: a reviewer that cannot actually
 * review rubber-stamps the work or invents faults, and both are worse than no
 * review, so grunt-only is a legitimate and common shape.
 *
 * A model whose files disagree on the variant is reported rather than silently
 * resolved — that only happens when something wrote them out of band, and
 * quietly picking a side would hide it.
 *
 * @param {Array<{modelId: string, role?: string, variant?: string}>} entries
 * @returns {{roster: {version: number, models: Array<{id: string, variant?: string, roles?: string[]}>}, conflicts: string[]}}
 */
export function buildRoster(entries) {
  /** @type {Map<string, {variant?: string, roles: Set<string>}>} */
  const byId = new Map();
  const conflicts = [];
  for (const entry of entries) {
    if (!entry?.modelId) continue;
    const existing = byId.get(entry.modelId);
    if (!existing) {
      byId.set(entry.modelId, {
        variant: entry.variant,
        roles: new Set(entry.role ? [entry.role] : ALL_ROLES),
      });
      continue;
    }
    if (entry.role) existing.roles.add(entry.role);
    if ((existing.variant ?? "") !== (entry.variant ?? "")) {
      conflicts.push(
        `${entry.modelId}: its agents disagree on variant (${existing.variant ?? "none"} vs ${entry.variant ?? "none"}); keeping ${existing.variant ?? "none"}`,
      );
    }
  }
  const models = [...byId.entries()]
    .map(([id, v]) => {
      const roles = ALL_ROLES.filter((r) => v.roles.has(r));
      /** @type {{id: string, variant?: string, roles?: string[]}} */
      const out = { id };
      if (v.variant) out.variant = v.variant;
      if (roles.length !== ALL_ROLES.length) out.roles = roles;
      return out;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
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
      if (key !== "id" && key !== "variant" && key !== "roles") {
        errors.push(`${at} has unknown key "${key}"`);
      }
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
    if (entry.roles !== undefined) {
      if (!Array.isArray(entry.roles) || entry.roles.length === 0) {
        errors.push(`${at}.roles must be a non-empty array when present`);
      } else {
        for (const r of entry.roles) {
          if (!ALL_ROLES.includes(r)) {
            errors.push(`${at}.roles has unknown role ${JSON.stringify(r)}`);
          }
        }
      }
    }
  });
  return errors;
}

/**
 * Compare the roster on disk with the one being applied.
 *
 * `changed` covers both a retuned variant and a narrowed or widened role set on
 * a model that stays. Narrowing DOES delete an agent file, so it is reported
 * here in words and still gated by the caller's removal guard — the invariant
 * worth keeping simple is "no generated agent disappears without an explicit
 * opt-in", not "only whole models are protected".
 *
 * @param {{models: Array<{id: string, variant?: string, roles?: string[]}>}} current
 * @param {{models: Array<{id: string, variant?: string, roles?: string[]}>}} next
 * @returns {{added: string[], removed: string[], changed: string[], unchanged: string[], removedRoles: Array<{id: string, role: string}>}}
 */
export function diffRoster(current, next) {
  const key = (m) => ({ variant: m.variant ?? "", roles: rolesOf(m.roles) });
  const cur = new Map((current?.models ?? []).map((m) => [m.id, key(m)]));
  const nxt = new Map((next?.models ?? []).map((m) => [m.id, key(m)]));
  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];
  const removedRoles = [];

  const label = (id, k) =>
    `${id}${k.variant ? `@${k.variant}` : ""}` +
    (k.roles.length !== ALL_ROLES.length ? ` (${k.roles.join("+")} only)` : "");

  for (const [id, k] of nxt) {
    const before = cur.get(id);
    if (!before) {
      added.push(label(id, k));
      continue;
    }
    const notes = [];
    if (before.variant !== k.variant) {
      notes.push(`${before.variant || "no variant"} -> ${k.variant || "no variant"}`);
    }
    const dropped = before.roles.filter((r) => !k.roles.includes(r));
    const gained = k.roles.filter((r) => !before.roles.includes(r));
    for (const role of dropped) removedRoles.push({ id, role });
    if (dropped.length || gained.length) {
      notes.push(
        `roles ${before.roles.join("+")} -> ${k.roles.join("+")}` +
          (dropped.length ? ` (drops ${dropped.join(", ")})` : ""),
      );
    }
    if (notes.length === 0) unchanged.push(id);
    else changed.push(`${id}: ${notes.join("; ")}`);
  }
  for (const id of cur.keys()) if (!nxt.has(id)) removed.push(id);

  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
    unchanged: unchanged.sort(),
    removedRoles: removedRoles.sort((a, b) => `${a.id}${a.role}`.localeCompare(`${b.id}${b.role}`)),
  };
}
