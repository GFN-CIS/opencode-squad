// Shape of src/benchmarks.json, shared by the producer (scripts/refresh-
// benchmarks.mjs validates before writing, so a reshaped AA response fails CI
// instead of landing on master) and the consumer (the plugin validates a copy
// fetched from GitHub before caching it).
//
// Objects are loose on purpose: adding a field is NOT a breaking change and
// must not bump SCHEMA_VERSION. Bump it only when an existing field changes
// meaning/type or goes away — older installed plugins then stop applying fresh
// snapshots and tell the user to update instead of misreading them.

import { tool } from "@opencode-ai/plugin";

const z = tool.schema;

export const SCHEMA_VERSION = 1;

const num = z.number().nullable();
const str = z.string().nullable();

const modelEntry = z.looseObject({
  name: z.string(),
  creator: str,
  release_date: str,
  intelligence: z.number(),
  coding: num,
  math: num,
  agentic: z.record(z.string(), num),
  benchmarks: z.record(z.string(), num),
  price_blended: num,
  price_input: num,
  price_output: num,
  tps: num,
  ttft: num,
});

const snapshotSchema = z.looseObject({
  _meta: z.looseObject({
    schema: z.literal(SCHEMA_VERSION),
    generated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  models: z.record(z.string(), modelEntry).refine((m) => Object.keys(m).length > 0, "no models"),
});

/**
 * @param {unknown} json  a parsed benchmarks.json candidate
 * @returns {{ok: true, snapshot: any}
 *   | {ok: false, reason: "schema-ahead", schema: number}
 *   | {ok: false, reason: "invalid", error: string}}
 */
export function checkSnapshot(json) {
  const version = /** @type {any} */ (json)?._meta?.schema;
  // A newer schema is checked before the shape: its body is by definition
  // something this version can't read, and the caller must tell the user to
  // update rather than treat it as a corrupt download.
  if (Number.isInteger(version) && version > SCHEMA_VERSION) {
    return { ok: false, reason: "schema-ahead", schema: version };
  }
  const r = snapshotSchema.safeParse(json);
  if (!r.success) return { ok: false, reason: "invalid", error: r.error.message };
  return { ok: true, snapshot: r.data };
}
