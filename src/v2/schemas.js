// JSON Schema inputs for the squad_* tools on OpenCode 2.
// Wording comes from src/squad-tools.js.

import { ARG_DESCRIPTIONS } from "../squad-tools.js";

const agentEntry = {
  type: "object",
  properties: {
    variant: { type: "string", description: ARG_DESCRIPTIONS["agent.variant"] },
    description: { type: "string", description: ARG_DESCRIPTIONS["agent.description"] },
    notes: { type: "string", description: ARG_DESCRIPTIONS["agent.notes"] },
    steps: { type: "integer", exclusiveMinimum: 0, description: ARG_DESCRIPTIONS["agent.steps"] },
    disable: { type: "boolean", description: ARG_DESCRIPTIONS["agent.disable"] },
  },
  additionalProperties: false,
};

/** @param {string} description */
const agentMap = (description) => ({
  type: "object",
  additionalProperties: agentEntry,
  description,
});

export const SQUAD_COMPACT_INPUT = {
  type: "object",
  properties: {
    task_id: { type: "string", description: ARG_DESCRIPTIONS["compact.task_id"] },
  },
  required: ["task_id"],
  additionalProperties: false,
};

export const SQUAD_DUMP_INPUT = {
  type: "object",
  properties: {
    directory: { type: "string", description: ARG_DESCRIPTIONS["dump.directory"] },
  },
  additionalProperties: false,
};

export const SQUAD_PATCH_INPUT = {
  type: "object",
  properties: {
    grunts: agentMap(ARG_DESCRIPTIONS["patch.grunts"]),
    drills: agentMap(ARG_DESCRIPTIONS["patch.drills"]),
    allow_remove: { type: "boolean", description: ARG_DESCRIPTIONS["patch.allow_remove"] },
    directory: { type: "string", description: ARG_DESCRIPTIONS["patch.directory"] },
  },
  additionalProperties: false,
};
