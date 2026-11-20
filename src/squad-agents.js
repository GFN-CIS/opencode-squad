// Register the squad's agents with OpenCode through the plugin agent API,
// from the roster in squad.json (src/squad-store.js), instead of writing
// agent files (#85).
//
// The ordering the host imposes (verified on 2.1.3; see #85, #87, #88):
// agent transforms run in registration order, and a plugin's transform
// registered during setup runs BEFORE the built-in config-agent plugin, which
// then appends the user's global permission rules to every agent that exists
// and applies agent files and config entries on top.
//
//   early  (setup): creates one throwaway probe agent and nothing else. The
//          config plugin appends the user's global rules to it, which is the
//          only exact way to learn them. No squad id is touched here, so a
//          user's agent holding a squad id never sees a squad field (#88).
//   late   (registered before the first request selects an agent, then
//          reload): runs after the config plugin. It reads the global rules
//          off the probe and removes it, then builds each squad agent from a
//          fresh default: base, global rules, role rules LAST. With the host's
//          last-match evaluation the role decides: a drill stays read-only
//          under a global allow-all, and the host hides its denied tools.
//
// Until the late transform runs, squad agents do not exist: a request for one
// fails as an unknown agent instead of running with the wrong rules (#87).
//
// Which agents are ours: one built from the roster, or one that an earlier
// version generated as a file in the global agent dir, when the live agent at
// that id IS that file (same prompt and model). Any other agent at a squad id
// belongs to the user and is left exactly as the host built it.

import crypto from "node:crypto";

import { findPromptFence, placeholderBody, wrapPrompt } from "./prompt-inject.js";
import { NOTES_CLOSE, NOTES_OPEN, ROLE_KEYS } from "./roster.js";
import { roleRules, slugForModel, squadRoleOf } from "./workers.js";

/**
 * The throwaway agent the early transform creates for the late one to read:
 * a fresh id per plugin instance, so no agent of the user's can hold it.
 */
export function newProbeId() {
  return `opencode-squad-probe-${crypto.randomUUID().slice(0, 12)}`;
}
/** Marks where the probe's own rules end and the global ones begin. */
const PROBE_MARK = Object.freeze({ action: "opencode-squad-probe", resource: "*", effect: "deny" });

/**
 * @typedef {{action: string, resource: string, effect: string}} Rule
 * @typedef {{id: string, role: "grunt"|"drill", modelId: string, description: string,
 *   system: string, model: {id: string, providerID: string, variant?: string},
 *   steps?: number, permissions: Rule[]}} AgentSpec
 * @typedef {{definition: import("./squad-apply.js").LegacyDefinition | null}} LegacyAgent
 *   a generated file from the global agent dir, as the host builds it alone
 * @typedef {{defaults?: Record<string, unknown>}} ProbeSeen
 *   defaults: a fresh agent as the host creates one, seen by the early transform
 */

/**
 * Roster entries whose model ids map to the same agent id (`p/m-1` and
 * `p/m.1` are both `grunt-p-m-1`). Either one would silently replace the
 * other, so neither is registered and squad_patch refuses the roster (#90).
 *
 * @param {{grunts?: Record<string, any>, drills?: Record<string, any>}} roster
 * @returns {Array<{id: string, entries: string[]}>}  entries as "role model"
 */
export function rosterCollisions(roster) {
  /** @type {Map<string, string[]>} */
  const byId = new Map();
  for (const [key, role] of Object.entries(ROLE_KEYS)) {
    const map = /** @type {Record<string, unknown> | undefined} */ (
      /** @type {any} */ (roster)?.[key]
    );
    for (const modelId of Object.keys(map ?? {})) {
      const id = slugForModel(modelId, role);
      byId.set(id, [...(byId.get(id) ?? []), `${role} ${modelId}`]);
    }
  }
  return [...byId]
    .filter(([, entries]) => entries.length > 1)
    .map(([id, entries]) => ({ id, entries }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The agents a roster asks for. A disabled entry stays in the roster (its
 * settings survive) but is not registered; nor is an entry whose agent id
 * collides with another's (rosterCollisions).
 *
 * @param {{grunts?: Record<string, any>, drills?: Record<string, any>}} roster
 * @param {{describe: (role: "grunt"|"drill", modelId: string) => string,
 *   prompt: (role: "grunt"|"drill") => string | null}} io
 *   prompt: the role prompt body now; null falls back to the placeholder,
 *   which the context hook replaces on every request anyway
 * @returns {AgentSpec[]}
 */
export function agentSpecs(roster, { describe, prompt }) {
  const clashing = new Set(rosterCollisions(roster).map((c) => c.id));
  /** @type {AgentSpec[]} */
  const specs = [];
  for (const [key, role] of Object.entries(ROLE_KEYS)) {
    const map = /** @type {Record<string, Record<string, any> | undefined> | undefined} */ (
      roster
    )?.[key];
    for (const [modelId, entry] of Object.entries(map ?? {})) {
      if (entry?.disable) continue;
      const id = slugForModel(modelId, role);
      if (clashing.has(id)) continue;
      const slash = modelId.indexOf("/");
      const variant = typeof entry?.variant === "string" ? entry.variant.trim() : "";
      const notes = typeof entry?.notes === "string" ? entry.notes.trim() : "";
      const body = wrapPrompt(role, prompt(role) ?? placeholderBody(role));
      specs.push({
        id,
        role,
        modelId,
        description: describe(role, modelId),
        system: notes ? `${body}\n\n${NOTES_OPEN}\n${notes}\n${NOTES_CLOSE}` : body,
        model: {
          providerID: modelId.slice(0, slash),
          id: modelId.slice(slash + 1),
          ...(variant ? { variant } : {}),
        },
        ...(typeof entry?.steps === "number" ? { steps: entry.steps } : {}),
        permissions: roleRules(role),
      });
    }
  }
  return specs;
}

/** Whether an agent's system prompt is one this plugin generated. @param {unknown} system */
export function isSquadSystem(system) {
  return typeof system === "string" && findPromptFence(system) !== null;
}

/**
 * The early transform: the probe, nothing else. A primary agent cannot be
 * dispatched by the subagent tool, a hidden one is never selected, and its
 * own rules deny everything, so it cannot run in the moment it exists.
 *
 * @param {{update: (id: string, f: (agent: any) => void) => void}} editor
 * @param {string} probeId
 * @param {ProbeSeen} [seen]  receives the host's fresh-agent defaults
 */
export function earlyTransform(editor, probeId, seen = {}) {
  editor.update(probeId, (agent) => {
    seen.defaults = JSON.parse(JSON.stringify(agent));
    agent.mode = "primary";
    agent.hidden = true;
    agent.description = "opencode-squad internal probe; removed before any request";
    agent.system = "";
    if (!Array.isArray(agent.permissions)) agent.permissions = [];
    agent.permissions.push({ action: "*", resource: "*", effect: "deny" }, { ...PROBE_MARK });
  });
}

/**
 * The user's global rules, as the config plugin appended them to the probe.
 *
 * @param {any} probe
 * @returns {Rule[]}
 */
function globalRules(probe) {
  const rules = Array.isArray(probe?.permissions) ? probe.permissions : [];
  const mark = rules.findLastIndex(
    (/** @type {any} */ r) =>
      r?.action === PROBE_MARK.action &&
      r?.resource === PROBE_MARK.resource &&
      r?.effect === PROBE_MARK.effect,
  );
  return mark === -1 ? [] : rules.slice(mark + 1).map((/** @type {Rule} */ r) => ({ ...r }));
}

/** JSON with object keys sorted, for comparing definitions. @param {unknown} v */
function canonical(v) {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );
}

/**
 * Whether the live agent at an id IS the legacy file there: equal, field for
 * field, to what the host builds from that file alone (fresh defaults, the
 * file's fields, then the global rules and the file's own rules). The host
 * loads agents from several config dirs, and another one may hold the id
 * with any field changed (#88); verifying the file proves we own the file,
 * not the id. Without the host's defaults or a reproducible file, never.
 *
 * @param {any} agent
 * @param {LegacyAgent | undefined} file
 * @param {{defaults?: Record<string, unknown>, globals: Rule[]}} host
 */
export function isLegacyFile(agent, file, { defaults, globals }) {
  const def = file?.definition;
  if (!def || !agent || !defaults) return false;
  const { id: _i, name: _n, ...base } = /** @type {Record<string, any>} */ (defaults);
  const expected = {
    ...base,
    ...def.fields,
    permissions: [.../** @type {any[]} */ (base.permissions ?? []), ...globals, ...def.permissions],
  };
  const { id: _a, name: _b, ...live } = agent;
  // Rules as a multiset: transforms after the config plugin (the browser
  // plugin's deny, on 2.1.3) append to every agent, so on a file agent they
  // land after the file's own rules, and on the probe before. A user's file
  // cannot reorder rules without changing them.
  /** @param {any} a */
  const rules = (a) => (Array.isArray(a.permissions) ? a.permissions : []).map(canonical).sort();
  return (
    canonical({ ...live, permissions: rules(live) }) ===
    canonical({ ...expected, permissions: rules(expected) })
  );
}

/**
 * @param {any} agent  a fresh default from the host's editor
 * @param {AgentSpec} spec
 * @param {Rule[]} globals
 */
function build(agent, spec, globals) {
  agent.mode = "subagent";
  agent.hidden = true;
  agent.description = spec.description;
  agent.system = spec.system;
  agent.model = { ...spec.model };
  if (spec.steps !== undefined) agent.steps = spec.steps;
  if (!Array.isArray(agent.permissions)) agent.permissions = [];
  agent.permissions.push(
    ...globals.map((r) => ({ ...r })),
    ...spec.permissions.map((r) => ({ ...r })),
  );
}

/**
 * @param {{list: () => readonly any[], get: (id: string) => any, update: (id: string, f: (agent: any) => void) => void, remove: (id: string) => void}} editor
 * @param {AgentSpec[]} specs
 * @param {Map<string, LegacyAgent>} [legacy]  the generated files an earlier
 *   version wrote to the global agent dir, by agent id, verified by their
 *   marker (src/squad-apply.js readLegacySquad). Files from before the
 *   role-prompt fence, and every `worker-*`, are only recognisable this way:
 *   the marker is a YAML comment the host never exposes.
 * @param {{id: string, seen: ProbeSeen}} [probe]  this instance's probe and
 *   what the early transform saw
 * @returns {{globals: Rule[], built: string[], foreign: string[], hidden: string[], stray: string[], kept: string[]}}
 *   globals: the user's global rules, read off the probe;
 *   built: the squad agents this transform created: the only ones the
 *          plugin polices per request;
 *   foreign: roster ids another agent already holds (left alone);
 *   hidden: legacy generated agents removed because the roster no longer has them;
 *   stray: generated-looking agents from elsewhere (a project's own agent dir),
 *          left alone because this plugin did not verify them as its own;
 *   kept: ids of legacy files the roster dropped, where another agent the
 *         host loaded holds the id (left alone)
 */
export function lateTransform(editor, specs, legacy = new Map(), probe = { id: "", seen: {} }) {
  const globals = globalRules(editor.get(probe.id));
  editor.remove(probe.id);
  const host = { defaults: probe.seen.defaults, globals };
  const wanted = new Map(specs.map((s) => [s.id, s]));
  /** @type {string[]} */
  const foreign = [];
  /** @type {string[]} */
  const hidden = [];
  /** @type {string[]} */
  const stray = [];
  /** @type {string[]} */
  const kept = [];
  /** @type {string[]} */
  const built = [];
  for (const agent of [...editor.list()]) {
    const id = String(agent?.id ?? "");
    if (wanted.has(id)) continue;
    if (legacy.has(id)) {
      if (isLegacyFile(agent, legacy.get(id), host)) {
        editor.remove(id);
        hidden.push(id);
      } else {
        kept.push(id);
      }
    } else if (squadRoleOf(id) !== null && isSquadSystem(agent?.system)) {
      stray.push(id);
    }
  }
  for (const spec of specs) {
    const current = editor.get(spec.id);
    if (current) {
      if (!isLegacyFile(current, legacy.get(spec.id), host)) {
        foreign.push(spec.id);
        continue;
      }
      // Our own old file: rebuilt from scratch, so none of its fields leak.
      editor.remove(spec.id);
    }
    editor.update(spec.id, (agent) => build(agent, spec, globals));
    built.push(spec.id);
  }
  return {
    globals,
    built: built.sort(),
    foreign: foreign.sort(),
    hidden: hidden.sort(),
    stray: stray.sort(),
    kept: kept.sort(),
  };
}

/**
 * Whether a live squad agent still ends with its role's rules. Something that
 * appends rules after the late transform (the config plugin re-registered
 * behind it when the host reloaded plugins) would put the user's global rules
 * last again; the plugin then moves its late transform back to the end.
 *
 * @param {any} agent
 * @param {"grunt"|"drill"} role
 */
export function endsWithRoleRules(agent, role) {
  const rules = roleRules(role);
  const live = Array.isArray(agent?.permissions) ? agent.permissions : [];
  if (live.length < rules.length) return false;
  const tail = live.slice(-rules.length);
  return rules.every(
    (r, i) =>
      tail[i]?.action === r.action &&
      tail[i]?.resource === r.resource &&
      tail[i]?.effect === r.effect,
  );
}

/**
 * The host's wildcard match (`*` any run, `?` one char; a trailing ` *`
 * also matches the bare command), as OpenCode 2.1.3 evaluates rules.
 *
 * @param {string} input
 * @param {string} pattern
 */
function wildcard(input, pattern) {
  let re = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (re.endsWith(" .*")) re = `${re.slice(0, -3)}( .*)?`;
  return new RegExp(`^${re}$`, "s").test(input.replaceAll("\\", "/"));
}

/**
 * The tools of one request that the agent's rules leave usable, by the
 * host's own test: a tool is gone when the last rule for its permission
 * action denies every resource.
 *
 * @param {string[]} names  the request's tool names
 * @param {Rule[]} rules  the agent's live rules
 * @param {Map<string, string>} [actionOf]  tool name -> its permission action
 * @returns {string[]}  names to drop
 */
export function deniedTools(names, rules, actionOf = new Map()) {
  return names.filter((name) => {
    const action = actionOf.get(name) ?? name;
    const rule = rules.findLast((r) => wildcard(action, r.action));
    return rule?.resource === "*" && rule.effect === "deny";
  });
}
