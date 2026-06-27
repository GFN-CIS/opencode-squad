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
