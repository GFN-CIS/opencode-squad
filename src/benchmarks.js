// Look up an opencode `provider/model` id in the static Artificial Analysis
// snapshot (benchmarks.json, keyed by AA slug). The snapshot is provider-keyed
// by AA's own slug, so we normalize the opencode id and try a few candidates.

/**
 * Candidate AA slugs for an opencode model id, most-specific first.
 * - drop the provider, lowercase, dots/underscores -> dashes;
 * - strip `-fast`, `-latest`, trailing 8-digit dates, `-preview`;
 * - Anthropic naming flip: `claude-haiku-4-5` <-> `claude-4-5-haiku`.
 *
 * @param {string} modelId  e.g. "openai/gpt-5.5", "anthropic/claude-haiku-4-5"
 * @returns {string[]}
 */
export function slugCandidates(modelId) {
  const raw = String(modelId).includes("/")
    ? String(modelId).split("/").slice(1).join("/")
    : String(modelId);
  const base = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const cands = new Set();
  const add = (s) => s && cands.add(s);
  const variants = (s) => {
    add(s);
    add(s.replace(/-fast$/, ""));
    add(s.replace(/-latest$/, ""));
    add(s.replace(/-\d{8}$/, "")); // dated snapshot suffix
    add(s.replace(/-preview$/, ""));
    add(`${s}-preview`);
  };
  variants(base);
  // anthropic family/size flip: claude-<size>-<ver> <-> claude-<ver>-<size>
  const m = base.match(/^claude-(opus|sonnet|haiku)-(.+)$/);
  if (m) variants(`claude-${m[2]}-${m[1]}`);
  const m2 = base.match(/^claude-(.+)-(opus|sonnet|haiku)$/);
  if (m2) variants(`claude-${m2[2]}-${m2[1]}`);
  return [...cands];
}

/**
 * @param {string} modelId
 * @param {Record<string, any>} models  the `models` object from benchmarks.json
 * @returns {{slug:string, data:any}|null}
 */
export function lookupBenchmark(modelId, models) {
  if (!models) return null;
  for (const slug of slugCandidates(modelId)) {
    if (models[slug]) return { slug, data: models[slug] };
  }
  return null;
}

/**
 * One aggregated agentic score (0-100) from AA's agentic/tool-use benchmarks —
 * there is no single agentic index in the API. Mean of the available core
 * agentic evals (tau2 tool-use, terminalbench autonomous terminal), each 0-1,
 * scaled to 0-100. Null if none are scored.
 *
 * @param {any} data  a benchmarks.json model entry
 * @returns {number|null}
 */
export function agenticScore(data) {
  const a = (data && data.agentic) || {};
  const vals = [a.tau2, a.terminalbench_v2_1].filter(
    (v) => typeof v === "number",
  );
  if (!vals.length) return null;
  return Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 100);
}

/**
 * Minimal decision-useful one-liner for the inventory: the aggregated indices
 * sarge needs to route — general / coding / agentic / cost. No raw sub-benchmark
 * details, no speed. Returns null when the model isn't in the snapshot.
 *
 * @param {string} modelId  e.g. "openai/gpt-5.5"
 * @param {Record<string, any>} models  benchmarks.json `models`
 * @returns {string|null}  e.g. "AA intel 55 · code 74 · agentic 90 · $10/M"
 */
export function formatBench(modelId, models) {
  const r = lookupBenchmark(modelId, models);
  if (!r) return null;
  const d = r.data;
  const parts = [];
  if (typeof d.intelligence === "number") parts.push(`intel ${Math.round(d.intelligence)}`);
  if (typeof d.coding === "number") parts.push(`code ${Math.round(d.coding)}`);
  const ag = agenticScore(d);
  if (ag != null) parts.push(`agentic ${ag}`);
  if (typeof d.price_blended === "number") parts.push(`$${d.price_blended}/M`);
  return parts.length ? `AA ${parts.join(" · ")}` : null;
}
