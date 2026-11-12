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

/**
 * Pull the model id out of an agent markdown file's YAML frontmatter.
 * Scoped to the leading `---`…`---` block so a stray `model:` in the body
 * (prompt text) can't be mistaken for the agent's model.
 *
 * @param {string} content
 * @returns {string|null}
 */
export function extractModelId(content) {
  const txt = String(content);
  const fm = txt.match(/^---\n([\s\S]*?)\n---/);
  const scope = fm ? fm[1] : txt;
  const m = scope.match(/^model:\s*(.+?)\s*$/m);
  return m ? m[1].split("#")[0].trim() : null;
}

/**
 * Scan an agent dir for grunt-/drill- files and collect the unique set of
 * `provider/model` ids they target (a grunt and a drill of the same model
 * collapse to one entry). Hand-authored grunt-/drill- agents count too.
 *
 * @param {string} dir  agent directory (e.g. ~/.config/opencode/agent)
 * @returns {string[]}  sorted, deduped model ids
 */
export function discoverSquadModels(dir) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const ids = new Set();
  for (const f of files) {
    if (!/^(?:grunt|drill)-.*\.md$/.test(f)) continue;
    let txt;
    try {
      txt = fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    const id = extractModelId(txt);
    if (id) ids.add(id);
  }
  return [...ids].sort();
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
 * @param {string} dir  agent directory to scan
 * @param {{models?:Record<string, any>}} [existing]  prior model_data.json
 * @param {string} [generated]  ISO date string (passed in; no Date here)
 * @returns {{_meta:object, models:Record<string, any>}}
 */
export function buildModelData(dir, existing, generated) {
  const ids = discoverSquadModels(dir);
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
 * Read and parse a model_data.json file. Returns null if absent/unreadable.
 *
 * @param {string} file  path to model_data.json
 * @returns {{_meta?:object, models:Record<string, any>}|null}
 */
export function readModelData(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed?.models || parsed?.providers ? { models: {}, ...parsed } : null;
  } catch {
    return null;
  }
}
