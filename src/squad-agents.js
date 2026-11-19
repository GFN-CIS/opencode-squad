// Register the squad's agents with OpenCode through the plugin agent API,
// from the roster in squad.json (src/squad-store.js), instead of writing
// agent files (#85).
//
// Two transforms, because of how the host orders them (verified on 2.1.3;
// see #85). Agent transforms run in registration order, and a plugin's
// registered during setup runs BEFORE the built-in config-agent plugin, which
// then (a) appends the user's global permission rules to every agent that
// exists and (b) applies agent files, whose fields override ours.
//
//   early  (registered in setup): creates each agent, so it exists from the
//          first turn and the config plugin gives it the user's global rules.
//   late   (registered on the first request, then reload): runs after the
//          config plugin, on every later reload too. It hides legacy
//          generated agents that are no longer in the roster, sets every field
//          again (so a same-id legacy file cannot leak steps, color or rules
//          into ours) and re-appends the role's rules LAST. With the host's
//          last-match permission evaluation that gives the order a file agent
//          gets: base, global, own. The host then filters the child's tool
//          catalog by them: a drill sees read-only tools only.
//
// A roster id whose agent is hand-authored (its system prompt has no
// squad:prompt fence after the config plugin ran) is left alone and reported:
// the user's agent wins, and squad_patch refuses that id.

import { findPromptFence, placeholderBody, wrapPrompt } from "./prompt-inject.js";
import { NOTES_CLOSE, NOTES_OPEN, ROLE_KEYS } from "./roster.js";
import { roleRules, slugForModel, squadRoleOf } from "./workers.js";

/**
 * @typedef {{id: string, role: "grunt"|"drill", modelId: string, description: string,
 *   system: string, model: {id: string, providerID: string, variant?: string},
 *   steps?: number, permissions: Array<{action: string, resource: string, effect: string}>}} AgentSpec
 */

/**
 * The agents a roster asks for. A disabled entry stays in the roster (its
 * settings survive) but is not registered.
 *
 * @param {{grunts?: Record<string, any>, drills?: Record<string, any>}} roster
 * @param {{describe: (role: "grunt"|"drill", modelId: string) => string,
 *   prompt: (role: "grunt"|"drill") => string | null}} io
 *   prompt: the role prompt body now; null falls back to the placeholder,
 *   which the context hook replaces on every request anyway
 * @returns {AgentSpec[]}
 */
export function agentSpecs(roster, { describe, prompt }) {
  /** @type {AgentSpec[]} */
  const specs = [];
  for (const [key, role] of Object.entries(ROLE_KEYS)) {
    const map = /** @type {Record<string, Record<string, any> | undefined> | undefined} */ (
      roster
    )?.[key];
    for (const [modelId, entry] of Object.entries(map ?? {})) {
      if (entry?.disable) continue;
      const slash = modelId.indexOf("/");
      const variant = typeof entry?.variant === "string" ? entry.variant.trim() : "";
      const notes = typeof entry?.notes === "string" ? entry.notes.trim() : "";
      const body = wrapPrompt(role, prompt(role) ?? placeholderBody(role));
      specs.push({
        id: slugForModel(modelId, role),
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

/**
 * Set every field the squad owns. Fields a legacy file could carry and the
 * roster does not (color, steps) are cleared, not inherited.
 *
 * @param {any} agent  the host's mutable agent
 * @param {AgentSpec} spec
 */
function shape(agent, spec) {
  agent.mode = "subagent";
  agent.hidden = true;
  agent.description = spec.description;
  agent.system = spec.system;
  agent.model = { ...spec.model };
  delete agent.color;
  if (spec.steps === undefined) delete agent.steps;
  else agent.steps = spec.steps;
  if (!Array.isArray(agent.permissions)) agent.permissions = [];
  agent.permissions.push(...spec.permissions.map((r) => ({ ...r })));
}

/** Whether an agent's system prompt is one this plugin generated. @param {unknown} system */
export function isSquadSystem(system) {
  return typeof system === "string" && findPromptFence(system) !== null;
}

/**
 * @param {{update: (id: string, f: (agent: any) => void) => void}} editor
 * @param {AgentSpec[]} specs
 */
export function earlyTransform(editor, specs) {
  for (const spec of specs) editor.update(spec.id, (agent) => shape(agent, spec));
}

/**
 * @param {{list: () => readonly any[], get: (id: string) => any, update: (id: string, f: (agent: any) => void) => void, remove: (id: string) => void}} editor
 * @param {AgentSpec[]} specs
 * @returns {{foreign: string[], hidden: string[]}}
 *   foreign: roster ids a hand-authored agent already holds (left alone);
 *   hidden: legacy generated agents removed because the roster no longer has them
 */
export function lateTransform(editor, specs) {
  const wanted = new Map(specs.map((s) => [s.id, s]));
  /** @type {string[]} */
  const foreign = [];
  /** @type {string[]} */
  const hidden = [];
  for (const agent of [...editor.list()]) {
    const id = String(agent?.id ?? "");
    if (wanted.has(id) || squadRoleOf(id) === null || !isSquadSystem(agent?.system)) continue;
    editor.remove(id);
    hidden.push(id);
  }
  for (const spec of specs) {
    const current = editor.get(spec.id);
    if (current && !isSquadSystem(current.system)) {
      foreign.push(spec.id);
      continue;
    }
    editor.update(spec.id, (agent) => shape(agent, spec));
  }
  return { foreign: foreign.sort(), hidden: hidden.sort() };
}
