// Build and read model_data.json — the per-squad-model performance snapshot.
//
// Unlike src/benchmarks.json (the full Artificial Analysis dump, keyed by AA
// slug), model_data.json is small, hand-editable, and keyed by the opencode
// `provider/model` id. It holds ONLY the models that currently have a
// grunt-/drill- agent, with the decision-useful AA indices copied in plus an
// `info` field the user fills by hand ("good for coding, weak at long context").
//
// It is written ONLY by `scripts/squad-file-performance.mjs` (manual run), so
// the user can edit it freely. Re-running refreshes the perf indices from
// benchmarks.json but preserves `info` (and any other hand-added field).

import fs from "node:fs";
import path from "node:path";

import { lookupBenchmark, agenticScore } from "./benchmarks.js";

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
  return m ? m[1].trim() : null;
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

/**
 * Decision-useful perf indices for one opencode model id, looked up in the AA
 * snapshot. Returns an all-null entry (no `info` key) when AA doesn't score the
 * model — the row is still emitted so the user can fill it by hand.
 *
 * @param {string} modelId  opencode `provider/model` id
 * @param {Record<string, any>} benchmarksModels  benchmarks.json `models`
 * @returns {{name:string|null, aa_slug:string|null, intelligence:number|null,
 *   coding:number|null, agentic:number|null, price_blended:number|null}}
 */
export function perfFromBenchmark(modelId, benchmarksModels) {
  const r = lookupBenchmark(modelId, benchmarksModels);
  if (!r) {
    return {
      name: null,
      aa_slug: null,
      intelligence: null,
      coding: null,
      agentic: null,
      price_blended: null,
    };
  }
  const d = r.data;
  return {
    name: d.name ?? null,
    aa_slug: r.slug,
    intelligence: typeof d.intelligence === "number" ? Math.round(d.intelligence) : null,
    coding: typeof d.coding === "number" ? Math.round(d.coding) : null,
    agentic: agenticScore(d),
    price_blended: typeof d.price_blended === "number" ? d.price_blended : null,
  };
}

/**
 * Merge fresh perf over the previous model_data entries. The overlay order
 * `{ info: "", ...previous, ...freshPerf }` means:
 *   - a brand-new model gets an empty `info`;
 *   - an existing model keeps its `info` and any other hand-added field;
 *   - perf indices are refreshed from benchmarks every run (hand-edited perf
 *     numbers are intentionally overwritten — only non-perf fields survive).
 * Models no longer in the squad are dropped (not in `modelIds` → not emitted).
 *
 * @param {string[]} modelIds  ids discovered from the agent dir
 * @param {Record<string, any>} benchmarksModels  benchmarks.json `models`
 * @param {{models?:Record<string, any>}} [existing]  parsed prior model_data.json
 * @returns {Record<string, any>}  the `models` object keyed by opencode id
 */
export function mergeModelData(modelIds, benchmarksModels, existing = {}) {
  const prev = (existing && existing.models) || {};
  const out = {};
  for (const id of [...modelIds].sort()) {
    const fresh = perfFromBenchmark(id, benchmarksModels);
    out[id] = { info: "", ...(prev[id] || {}), ...fresh };
  }
  return out;
}

/**
 * Assemble the full model_data.json snapshot object.
 *
 * @param {string} dir  agent directory to scan
 * @param {Record<string, any>} benchmarksModels  benchmarks.json `models`
 * @param {{models?:Record<string, any>}} [existing]  prior model_data.json
 * @param {string} [generated]  ISO date string (passed in; no Date here)
 * @returns {{_meta:object, models:Record<string, any>}}
 */
export function buildModelData(dir, benchmarksModels, existing, generated) {
  const ids = discoverSquadModels(dir);
  const models = mergeModelData(ids, benchmarksModels, existing);
  return {
    _meta: {
      source: "derived from src/benchmarks.json (Artificial Analysis)",
      generated: generated ?? null,
      model_count: ids.length,
      note:
        "Per-squad-model perf snapshot, keyed by opencode provider/model id. " +
        "Holds only models that have a grunt-/drill- agent. `info` is " +
        "hand-editable and preserved across re-runs; perf indices are " +
        "overwritten from benchmarks on every run.",
    },
    models,
  };
}

/**
 * Format one model_data entry for the inventory line: the AA indices plus the
 * hand-written `info` note (so the orchestrator sees routing guidance inline).
 *
 * @param {any} entry  a model_data `models` entry (precomputed indices + info)
 * @returns {string|null}  e.g. "AA intel 55 · code 75 · agentic 85 · $11.25/M · note: good for coding"
 */
export function formatPerf(entry) {
  if (!entry) return null;
  const parts = [];
  if (typeof entry.intelligence === "number") parts.push(`intel ${entry.intelligence}`);
  if (typeof entry.coding === "number") parts.push(`code ${entry.coding}`);
  if (typeof entry.agentic === "number") parts.push(`agentic ${entry.agentic}`);
  if (typeof entry.price_blended === "number") parts.push(`$${entry.price_blended}/M`);
  let s = parts.length ? `AA ${parts.join(" · ")}` : null;
  const info = entry.info && String(entry.info).trim();
  if (info) s = s ? `${s} · note: ${info}` : `note: ${info}`;
  return s;
}

/**
 * Read and parse a model_data.json file. Returns null if absent/unreadable —
 * callers fall back to the raw benchmarks snapshot.
 *
 * @param {string} file  path to model_data.json
 * @returns {{_meta?:object, models:Record<string, any>}|null}
 */
export function readModelData(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && parsed.models ? parsed : null;
  } catch {
    return null;
  }
}
