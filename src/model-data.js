// Build and read model_data.json — hand-editable notes per squad model.
//
// Keyed by the opencode `provider/model` id and holding ONLY the models that
// have a grunt-/drill- agent. Every field is the user's: `info` (a routing
// note the squad_metrics tool shows next to the numbers), `billing`
// ("subscription" marks a flat-rate model), and `cache_ttl_seconds` (the
// provider's published prompt-cache TTL, read by src/cache-status.js; left
// unset where no TTL is published and reported as "unknown" rather than
// guessed). Benchmarks and prices are not stored here — they are fetched live
// (src/metrics-cache.js) so they cannot go stale in a file.
//
// The plugin refreshes the global file at startup: new squad models get an
// empty entry, removed ones are dropped, hand-added fields are preserved.

import fs from "node:fs";
import path from "node:path";

import { legacyHeaderFields, readFrontmatter } from "./frontmatter.js";
import { isGeneratedAgent } from "./workers.js";

/**
 * Pull the model id out of an agent markdown file's frontmatter, without its
 * `#variant` suffix. Only the leading frontmatter block counts: a `model:`
 * line in the body (prompt text) is not the agent's model, and a file with no
 * block has none. A block that is not valid YAML is read line by line (see
 * legacyHeaderFields), as the roster reader does.
 *
 * @param {string} content
 * @returns {string|null}
 */
export function extractModelId(content) {
  const fm = readFrontmatter(content);
  // A cut-off header is not read line by line: the cut may run through the
  // model line itself and yield a wrong id.
  const model =
    fm.state === "ok"
      ? fm.fields.model
      : fm.state === "invalid"
        ? legacyHeaderFields(fm.header).model
        : undefined;
  if (typeof model !== "string") return null;
  return model.split("#")[0].trim() || null;
}

/**
 * Scan an agent dir for squad files and collect the unique set of
 * `provider/model` ids they target (a grunt and a drill of the same model
 * collapse to one entry). Hand-authored grunt-/drill- agents count too, and so
 * do generated legacy `worker-` files: squad_dump still lists those agents
 * (src/squad-apply.js readSquad), so their models are still in the squad.
 *
 * Two lists name files whose model is unknown, not absent, so a caller that
 * would DROP models missing from `ids` must not act on this scan:
 *   unreadable   — the file could not be read at all;
 *   undetermined — a generated file from which no model could be read (a
 *                  cut-off or broken header): every generated agent has one.
 * A hand-authored file without a model owns no model_data entry, so it is
 * simply not counted — blocking on it would freeze the refresh for good over
 * a file that is not the squad's.
 *
 * @param {string} dir  agent directory (e.g. ~/.config/opencode/agent)
 * @returns {{ids: string[], unreadable: string[], undetermined: string[]}}  ids sorted and deduped
 */
export function scanSquadModels(dir) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return { ids: [], unreadable: [], undetermined: [] };
  }
  const ids = new Set();
  const unreadable = [];
  const undetermined = [];
  for (const f of files.sort()) {
    const m = /^(grunt|drill|worker)-.*\.md$/.exec(f);
    if (!m) continue;
    let txt;
    try {
      txt = fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      unreadable.push(f);
      continue;
    }
    const generated = isGeneratedAgent(txt);
    // A hand-authored worker-* agent was never part of the squad.
    if (m[1] === "worker" && !generated) continue;
    const id = extractModelId(txt);
    if (id) ids.add(id);
    else if (generated) undetermined.push(f);
  }
  return { ids: [...ids].sort(), unreadable, undetermined };
}

/**
 * @param {string} dir  agent directory
 * @returns {string[]}  sorted, deduped model ids (see scanSquadModels)
 */
export function discoverSquadModels(dir) {
  return scanSquadModels(dir).ids;
}

// Fields earlier versions copied in from Artificial Analysis. They are stale
// by construction (AA is no longer a source) and are stripped on the next
// startup refresh so nothing can render them again.
export const LEGACY_PERF_KEYS = [
  "name",
  "aa_slug",
  "intelligence",
  "coding",
  "agentic",
  "price_blended",
];

/**
 * Merge the squad's model ids over the previous model_data entries:
 *   - a brand-new model gets an empty `info` to fill by hand;
 *   - an existing model keeps every hand-added field (`info`, `billing`,
 *     `cache_ttl_seconds`, ...);
 *   - legacy AA perf fields are dropped;
 *   - models no longer in the squad are dropped.
 *
 * @param {string[]} modelIds  ids discovered from the agent dir
 * @param {{models?:Record<string, any>}} [existing]  parsed prior model_data.json
 * @returns {Record<string, any>}  the `models` object keyed by opencode id
 */
export function mergeModelData(modelIds, existing = {}) {
  const prev = existing?.models || {};
  /** @type {Record<string, any>} */
  const out = {};
  for (const id of [...modelIds].sort()) {
    const entry = { info: "", ...(prev[id] || {}) };
    for (const k of LEGACY_PERF_KEYS) delete entry[k];
    out[id] = entry;
  }
  return out;
}

/**
 * Assemble the full model_data.json snapshot object.
 *
 * Takes the ids of a scan the caller has already checked (scanSquadModels):
 * scanning again here could see a different directory than the one checked.
 *
 * @param {string[]} ids  model ids of the squad
 * @param {{models?:Record<string, any>, _meta?: object, [key: string]: unknown}} [existing]  prior model_data.json
 * @param {string} [generated]  ISO date string (passed in; no Date here)
 * @returns {{_meta:object, models:Record<string, any>}}
 */
export function buildModelData(ids, existing, generated) {
  const models = mergeModelData(ids, existing);
  const { _meta: _old, models: _oldModels, ...handKeys } = existing ?? {};
  return {
    ...handKeys,
    _meta: {
      generated: generated ?? null,
      model_count: ids.length,
      note:
        "Hand-editable. `providers`: per opencode provider id, your plan in your " +
        'own words ("Max 5x", "GLM Coding Pro", "api" for metered) — or ' +
        '{"plan": ..., "info": ...}, where `info` is a routing rule for every model ' +
        "of that provider. `models`: per squad model `info` (a routing rule for " +
        "that model) and `cache_ttl_seconds`. Rules go into the agent descriptions. " +
        "Everything here survives every refresh. Benchmarks and prices are NOT kept " +
        "here: the squad_metrics tool fetches them live.",
    },
    models,
  };
}

/**
 * Whether a freshly built snapshot's `models` differ from what's already on
 * disk — used by the startup auto-regen to write ONLY on a real change (new
 * grunt/drill, dropped legacy fields, edited info), never just to bump the date. The
 * merge keeps entry key order stable across runs, so a plain JSON compare of
 * the `models` objects is reliable.
 *
 * @param {{models?:Record<string, any>}} existing  parsed prior model_data.json
 * @param {{models?:Record<string, any>}} snapshot  freshly built snapshot
 * @returns {boolean}
 */
export function modelsChanged(existing, snapshot) {
  const a = JSON.stringify(existing?.models || {});
  const b = JSON.stringify(snapshot?.models || {});
  return a !== b;
}

/**
 * Read a model_data.json file, keeping three outcomes apart:
 *
 *   missing — no file: the first-run path, safe to generate one;
 *   invalid — the file exists but cannot be read or is not a JSON object with
 *             object-valued `models` / `providers`. It is the owner's
 *             hand-edited file, so NOTHING may overwrite it; `reason` names
 *             the problem without quoting its contents (V8's JSON errors embed
 *             a snippet of the text, which may hold private routing rules);
 *   ok      — parsed, with `models` defaulted to {}.
 *
 * @param {string} file  path to model_data.json
 * @returns {{state: "missing"} | {state: "invalid", reason: string} |
 *   {state: "ok", data: {_meta?: object, models: Record<string, any>, providers?: Record<string, any>, [k: string]: any}}}
 */
export function readModelDataFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    if (err?.code === "ENOENT") return { state: "missing" };
    return { state: "invalid", reason: `unreadable (${err?.code ?? err?.name ?? "error"})` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { state: "invalid", reason: jsonErrorWhere(e) };
  }
  /** @param {unknown} v @returns {v is Record<string, unknown>} */
  const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObject(parsed)) return { state: "invalid", reason: "not a JSON object" };
  for (const key of ["models", "providers"]) {
    if (parsed[key] !== undefined && !isObject(parsed[key])) {
      return { state: "invalid", reason: `"${key}" is not an object` };
    }
  }
  return { state: "ok", data: { models: {}, ...parsed } };
}

/**
 * Where a JSON.parse failed, without the source snippet V8 puts in the message.
 *
 * @param {unknown} e
 */
function jsonErrorWhere(e) {
  const msg = e instanceof Error ? e.message : "";
  const lc = /\(line (\d+) column (\d+)\)/.exec(msg);
  if (lc) return `invalid JSON at line ${lc[1]}, column ${lc[2]}`;
  const pos = /at position (\d+)/.exec(msg);
  if (pos) return `invalid JSON at position ${pos[1]}`;
  if (/end of JSON input/i.test(msg)) return "invalid JSON: unexpected end of input";
  return "invalid JSON";
}
