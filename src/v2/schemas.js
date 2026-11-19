// JSON Schema inputs for the squad_* tools on OpenCode 2.
// Wording comes from src/squad-tools.js. squad_patch's input is generated from
// its Zod schema (src/roster-schema.js), which also validates it at runtime.

import { ARG_DESCRIPTIONS } from "../squad-tools.js";

export { SQUAD_PATCH_INPUT } from "../roster-schema.js";

export const SQUAD_COMPACT_INPUT = {
  type: "object",
  properties: {
    sessionID: { type: "string", description: ARG_DESCRIPTIONS["compact.sessionID"] },
  },
  required: ["sessionID"],
  additionalProperties: false,
};

export const SQUAD_SESSION_INPUT = {
  type: "object",
  properties: {
    sessionIDs: {
      type: "array",
      items: { type: "string" },
      description: ARG_DESCRIPTIONS["session.sessionIDs"],
    },
  },
  additionalProperties: false,
};

export const SQUAD_DUMP_INPUT = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export const SQUAD_METRICS_INPUT = {
  type: "object",
  properties: {
    models: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      description: ARG_DESCRIPTIONS["metrics.models"],
    },
    full: { type: "boolean", description: ARG_DESCRIPTIONS["metrics.full"] },
  },
  required: ["models"],
  additionalProperties: false,
};
