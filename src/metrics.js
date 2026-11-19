// Model metrics for the squad_metrics tool: parse the two public sources,
// match them to opencode `provider/model` ids, and render the text the
// orchestrator reads. Pure — fetching and caching live in metrics-cache.js.
//
// Sources:
//   - SuperIndex (superindex.app, CC-BY-4.0): one composite score, rank,
//     list price and context per model.
//   - llmbenchmark.ai: per-benchmark scores aggregated from public
//     leaderboards (Terminal-Bench, Epoch, LiveBench, Vals, ...).
//
// Neither source uses opencode's ids, and they disagree with each other
// (`zai-coding-plan/glm-5.3` vs `zhipuai/glm-5.3` vs `z-ai/glm-5.3`), so
// matching compares the normalized model part. A SuperIndex row whose raw
// provider/model id is exactly the requested one (case aside) wins over any
// normalized match, so two ids that differ only by punctuation stay apart.
// A normalized match that several rows share keeps only the facts they all
// agree on and names the candidates. llmbenchmark identity is decided once
// per model over the whole source (resolveLlmbIdentity) and shared by every
// metric and by both views.

import { formatContextSize } from "./context.js";
import { squadRoleOf } from "./workers.js";

/**
 * The few benchmarks shown per model in the summary — chosen for coverage
 * across current frontier models and relevance to agentic coding work. The
 * full set for any model is one `squad_metrics({models})` call away.
 */
export const KEY_METRICS = [
  { metric: "tbench_4_0_accuracy", label: "TerminalBench4" },
  { metric: "epoch_apex_agents", label: "APEX-Agents" },
  { metric: "epoch_frontierswe", label: "FrontierSWE" },
  { metric: "livebench_coding", label: "LiveBench-coding" },
  { metric: "valsai_index", label: "ValsIndex" },
];

// llmbenchmark relays Artificial Analysis under these ids. AA is not a source
// for this plugin: its index was re-scored on an incomparable scale and its
// free tier returns nulls for most sub-benchmarks.
const EXCLUDED_SOURCES = new Set(["aa-api", "artificialanalysis"]);

// Serving-speed and pricing tiers: same weights, but billed on their own.
const TIER_SUFFIXES = [/-ultrafast$/, /-highspeed$/, /-fast$/, /-free$/];
// Aliases and snapshots of one model at one price.
const SAME_PRICE_SUFFIXES = [/-latest$/, /-preview$/, /-\d{8}$/];
// Suffixes that name the same weights.
const SAME_MODEL_SUFFIXES = [...TIER_SUFFIXES, ...SAME_PRICE_SUFFIXES];

/** @param {string} id  "provider/model" or bare "model" */
function modelKey(id) {
  const s = String(id);
  const model = s.includes("/") ? s.slice(s.indexOf("/") + 1) : s;
  return model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** @param {string} id  the provider part, normalized like modelKey; "" for a bare id */
function providerKey(id) {
  const s = String(id);
  return s.includes("/") ? modelKey(s.slice(0, s.indexOf("/"))) : "";
}

/**
 * Keys to try for an opencode id, exact first. Only suffixes that keep the
 * same weights are stripped — `glm-5.3` never matches `glm-5.3-flash`.
 *
 * @param {string} id
 * @param {RegExp[]} [suffixes]  suffixes that may be stripped
 * @returns {string[]}
 */
export function keyCandidates(id, suffixes = SAME_MODEL_SUFFIXES) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} k */
  const add = (k) => {
    if (k && !out.includes(k)) out.push(k);
  };
  const base = modelKey(id);
  add(base);
  let k = base;
  for (let changed = true; changed; ) {
    changed = false;
    for (const re of suffixes) {
      if (re.test(k)) {
        k = k.replace(re, "");
        add(k);
        changed = true;
      }
    }
  }
  // Anthropic naming flip: claude-haiku-4-5 <-> claude-4-5-haiku.
  for (const c of [...out]) {
    const a = c.match(/^claude-(opus|sonnet|haiku|fable)-(.+)$/);
    if (a) add(`claude-${a[2]}-${a[1]}`);
    const b = c.match(/^claude-(.+)-(opus|sonnet|haiku|fable)$/);
    if (b) add(`claude-${b[2]}-${b[1]}`);
  }
  return out;
}

/**
 * The current shape of the SuperIndex index (see indexSuperIndex). A cached
 * block without it was written by an earlier version: see superindexOf.
 */
export const SUPERINDEX_FORMAT = 2;

/**
 * Index key of a raw provider/model id: lowercased, no punctuation folded.
 * The "=" prefix keeps it apart from normalized keys, which never contain one.
 *
 * @param {string} id
 */
function exactKey(id) {
  return `=${String(id).toLowerCase()}`;
}

/**
 * The raw id itself first (only SuperIndex is indexed that way), then for
 * each candidate key a row under the id's own provider (`provider/key`),
 * then the shared basename. `key` is always the basename key.
 *
 * @template T
 * @param {string} id
 * @param {Record<string, T>} index  keyed by modelKey, optionally also by
 *   provider/modelKey and exactKey
 * @returns {{key: string, entry: T} | null}
 */
export function lookup(id, index) {
  if (!index) return null;
  const raw = exactKey(id);
  if (Object.hasOwn(index, raw)) return { key: modelKey(id), entry: index[raw] };
  const provider = providerKey(id);
  for (const key of keyCandidates(id)) {
    const exact = provider ? `${provider}/${key}` : null;
    if (exact && Object.hasOwn(index, exact)) return { key, entry: index[exact] };
    if (Object.hasOwn(index, key)) return { key, entry: index[key] };
  }
  return null;
}

/**
 * Whether a row found under `key` is this id's own serving row. A tier
 * (`-fast`, `-free`, ...) that fell back to its base model's row shares its
 * benchmarks, not its price or context limit — the base's would pass for the
 * tier's.
 *
 * @param {string} id  opencode id
 * @param {string} key  modelKey of the matched row
 */
function ownsRow(id, key) {
  return keyCandidates(id, SAME_PRICE_SUFFIXES).includes(key);
}

/**
 * What a model is served at: its context limit, how it is paid for and the
 * source's list price — one helper, so the summary and the full view agree.
 * The catalog's limit comes first; a row's limit and price count only when
 * the row is the model's own, a tier on its base model's row says both are
 * unknown instead of staying silent, and so does a match several rows share
 * where they disagree. A `-free` tier is free whatever price its row lists.
 * `billing` is the user's plan (null: metered API); `listed` marks `price`
 * as SuperIndex's list price, which is reference data, not the user's bill.
 *
 * @param {string} id  opencode id
 * @param {SiEntry|null} entry  matched SuperIndex row
 * @param {BillingContext & {context?: number|null}} [opts]
 *   context: opencode catalog context limit
 * @returns {{ctx: string|null, billing: string|null, price: string|null, listed: boolean}}
 */
function servingFacts(id, entry, { context = null, note, plans, authTypes } = {}) {
  const own = entry !== null && ownsRow(id, modelKey(entry.id));
  const ambiguous = Boolean(entry?.candidates);
  const limit = context ?? (own ? entry.context : null);
  const ctx = limit
    ? `ctx ${formatContextSize(limit)}`
    : entry && !own
      ? "tier ctx unknown"
      : ambiguous
        ? "ctx unknown (ambiguous match)"
        : null;
  const paid = billingFor(id, { note, plans, authTypes });
  const billing = paid.api ? null : `subscription: ${paid.plan ?? "plan not set"}`;
  /** @param {string|null} price @param {boolean} [listed] */
  const out = (price, listed = false) => ({ ctx, billing, price, listed });
  if (/-free$/.test(modelKey(id))) return out("free");
  if (entry && !own) return out("tier price unknown");
  if (entry?.priceIn == null) return out(ambiguous ? "price unknown (ambiguous match)" : null);
  return out(`$${entry.priceIn}/$${entry.priceOut ?? "?"}`, true);
}

/**
 * @typedef {{note?: any, plans?: Record<string, unknown>|null,
 *   authTypes?: Record<string, string>|null}} BillingContext
 *   note: the model's model_data.json entry; plans: its `providers`;
 *   authTypes: provider -> opencode auth type
 */

/** @param {unknown} v */
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * @typedef {{id: string, score: number|null, rank: number|null,
 *   status: string|null, confidence: number|null, priceIn: number|null,
 *   priceOut: number|null, context: number|null, candidates?: string[]}} SiEntry
 *   candidates: set when several raw ids share this entry's key; the entry
 *   then keeps the lowest id's scores and only the serving facts all agree on.
 */

/**
 * SuperIndex models.json -> compact index keyed three ways: by the raw id
 * (exactKey), by provider/modelKey, and by modelKey. Rows that share a
 * normalized key are merged there: the entry (the lowest id, so row order
 * does not matter) keeps a price or context only where all of them agree and
 * lists the candidates, while each row stays reachable under its raw id.
 *
 * @param {any} json
 * @returns {Record<string, SiEntry>}
 */
export function indexSuperIndex(json) {
  /** @type {SiEntry[]} */
  const rows = [];
  for (const m of Array.isArray(json?.models) ? json.models : []) {
    if (typeof m?.id !== "string") continue;
    rows.push({
      id: m.id,
      score: num(m.si_score),
      rank: num(m.rank),
      status: typeof m.status === "string" ? m.status : null,
      confidence: num(m.confidence_pct),
      priceIn: num(m.price_in),
      priceOut: num(m.price_out),
      context: num(m.context_window),
    });
  }
  return indexByIds(rows, mergeRows);
}

/**
 * Index items three ways: by raw id (exactKey), by provider/modelKey and by
 * modelKey, so lookup finds an exact id first and a normalized one only as a
 * fallback. Items sharing a key go through `merge` (sorted by id, so source
 * order does not matter); it decides what a shared key may still claim.
 *
 * @template {{id: string}} T
 * @param {T[]} items
 * @param {(group: T[]) => T} merge  called for groups of one too
 * @returns {Record<string, T>}
 */
function indexByIds(items, merge) {
  const sorted = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  /** @type {Record<string, T>} */
  const out = {};
  /** @param {(r: T) => string|null} keyOf */
  const indexBy = (keyOf) => {
    /** @type {Map<string, T[]>} */
    const groups = new Map();
    for (const r of sorted) {
      const k = keyOf(r);
      if (k === null) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)?.push(r);
    }
    for (const [k, group] of groups) out[k] = merge(group);
  };
  indexBy((r) => exactKey(r.id));
  indexBy((r) => {
    const provider = providerKey(r.id);
    return provider ? `${provider}/${modelKey(r.id)}` : null;
  });
  indexBy((r) => modelKey(r.id));
  return out;
}

/**
 * One index entry for rows sharing a key (sorted by id).
 *
 * @param {SiEntry[]} rows
 * @returns {SiEntry}
 */
function mergeRows(rows) {
  if (rows.length === 1) return rows[0];
  /** @param {"priceIn"|"priceOut"|"context"} f */
  const agreed = (f) => (rows.every((r) => r[f] === rows[0][f]) ? rows[0][f] : null);
  return {
    ...rows[0],
    priceIn: agreed("priceIn"),
    priceOut: agreed("priceOut"),
    context: agreed("context"),
    candidates: rows.map((r) => r.id),
  };
}

/**
 * The SuperIndex index to read from a metrics cache. A block of an earlier
 * format attributed a row to a requested id by normalized key only, so its
 * prices and context limits may be another model's: until it is refetched
 * (refreshMetrics treats it as due) only its basename scores are used, with
 * no serving facts.
 *
 * @param {MetricsData|null|undefined} data
 * @returns {Record<string, SiEntry>|undefined}
 */
export function superindexOf(data) {
  const block = data?.superindex;
  if (!block?.index) return undefined;
  if (block.format === SUPERINDEX_FORMAT) return block.index;
  /** @type {Record<string, SiEntry>} */
  const out = {};
  for (const [k, e] of Object.entries(block.index)) {
    if (k.includes("/") || k.startsWith("=")) continue;
    out[k] = { ...e, priceIn: null, priceOut: null, context: null };
  }
  return out;
}

/**
 * The current shape of the llmbenchmark indexes (indexScoreRows,
 * indexModelIds). Score rows carry it per metric (`formatByMetric`), the id
 * list on its block; rows without it were written by an earlier version,
 * which pooled distinct ids under one normalized key.
 */
export const LLMBENCH_FORMAT = 2;

/**
 * @typedef {{id: string, values: Array<{value: number, setting: string|null}>,
 *   candidates?: string[]}} ScoreEntry
 *   candidates: several llmbenchmark ids share this key; `values` is then
 *   empty, since no one id's scores may stand for the others.
 */

/**
 * llmbenchmark /v1/scores rows for one metric -> {key: {id, values}}, keyed
 * like indexSuperIndex (raw id, provider/modelKey, modelKey). Rows for the
 * same id at different settings are all kept: collapsing to the best one
 * would quietly report a max-effort number for every model. Rows of distinct
 * ids are never pooled: a key they share holds no values, only the ids.
 *
 * @param {any} rows
 * @returns {Record<string, ScoreEntry>}
 */
export function indexScoreRows(rows) {
  /** @type {Map<string, ScoreEntry>} */
  const byId = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const value = num(r?.value);
    if (typeof r?.modelId !== "string" || value === null) continue;
    const k = exactKey(r.modelId);
    if (!byId.has(k)) byId.set(k, { id: r.modelId, values: [] });
    byId.get(k)?.values.push({ value, setting: typeof r.setting === "string" ? r.setting : null });
  }
  return indexByIds([...byId.values()], (group) =>
    group.length === 1
      ? group[0]
      : { id: group[0].id, values: [], candidates: group.map((g) => g.id) },
  );
}

/**
 * llmbenchmark /v1/models list -> {key: {id}} (keyed like indexScoreRows),
 * so a model with no key-metric rows can still be looked up for its full
 * detail. A key several ids share lists them as `candidates`.
 *
 * @param {any} list
 * @returns {Record<string, {id: string, candidates?: string[]}>}
 */
export function indexModelIds(list) {
  /** @type {Map<string, {id: string, candidates?: string[]}>} */
  const byId = new Map();
  for (const m of Array.isArray(list) ? list : []) {
    if (typeof m?.id === "string" && !byId.has(exactKey(m.id)))
      byId.set(exactKey(m.id), { id: m.id });
  }
  return indexByIds([...byId.values()], (group) =>
    group.length === 1 ? group[0] : { id: group[0].id, candidates: group.map((g) => g.id) },
  );
}

/**
 * Score rows of one metric that are safe to attribute by id: written in the
 * current format. Older rows may pool several ids under one key.
 *
 * @param {MetricsData["scores"] | null | undefined} scores
 * @param {string} metric
 */
function currentRows(scores, metric) {
  return scores?.formatByMetric?.[metric] === LLMBENCH_FORMAT
    ? scores.byMetric?.[metric]
    : undefined;
}

/**
 * @typedef {{id: string, key: string} | {candidates: string[], key: string}} LlmbIdentity
 *   key: the basename key the match was made on (modelKey of the id when exact)
 */

/**
 * The one llmbenchmark model an opencode id stands for, decided once over the
 * whole source — the model-id list and every metric's score rows, both only
 * when written in the current format (an older one may hand back another
 * model's id) — and shared by every metric of the summary and by the full
 * view. All the ids the source holds are pooled into one index and looked up
 * once, so an exact id in any slice wins everywhere, and a basename or alias
 * match counts only when it names a single id across the whole source; one
 * that names several returns them all as `candidates`. Slice order does not
 * matter.
 *
 * @param {string} id  opencode id
 * @param {MetricsData|null|undefined} data
 * @returns {LlmbIdentity | null}
 */
export function resolveLlmbIdentity(id, data) {
  const lists = [
    data?.ids?.format === LLMBENCH_FORMAT ? data.ids.index : undefined,
    ...Object.keys(data?.scores?.byMetric ?? {}).map((m) => currentRows(data?.scores, m)),
  ];
  /** @type {Map<string, {id: string}>} */
  const ids = new Map();
  for (const index of lists) {
    for (const [k, e] of Object.entries(index ?? {})) {
      // Raw-id keys hold one id each; normalized keys only repeat them.
      // The lowest spelling of an id wins, whatever the slice order.
      if (k.startsWith("=") && typeof e?.id === "string") {
        const seen = ids.get(k);
        if (!seen || e.id < seen.id) ids.set(k, { id: e.id });
      }
    }
  }
  const hit = lookup(id, indexModelIds([...ids.values()]));
  if (!hit) return null;
  return hit.entry.candidates
    ? { candidates: hit.entry.candidates, key: hit.key }
    : { id: hit.entry.id, key: hit.key };
}

/**
 * What one metric's slice holds for a resolved identity. A current-format
 * slice is read by the identity's raw id only: a different id it holds is
 * another model and contributes nothing. An ambiguous identity shows as
 * ambiguous wherever a slice holds any of its candidates. A slice of an
 * earlier format (no raw-id keys, flagged in the header) counts only when
 * its basename match is the identity's id — or, when no identity could be
 * established from current data, when every earlier-format slice that
 * matches agrees on one id (`legacyId`).
 *
 * @param {string} id  opencode id
 * @param {Record<string, ScoreEntry>|undefined} slice
 * @param {boolean} current  the slice is at LLMBENCH_FORMAT
 * @param {LlmbIdentity|null} identity
 * @param {string|null} legacyId
 * @returns {{key: string, entry: ScoreEntry} | null}
 */
function sliceHit(id, slice, current, identity, legacyId) {
  if (!slice) return null;
  if (current) {
    if (!identity) return null;
    if ("id" in identity) {
      const e = slice[exactKey(identity.id)];
      return e ? { key: identity.key, entry: e } : null;
    }
    const held = identity.candidates.some((c) => Object.hasOwn(slice, exactKey(c)));
    return held
      ? {
          key: identity.key,
          entry: { id: identity.candidates[0], values: [], candidates: identity.candidates },
        }
      : null;
  }
  const hit = lookup(id, slice);
  if (!hit || hit.entry.candidates) return null;
  const want = identity && "id" in identity ? identity.id : identity ? null : legacyId;
  return want && hit.entry.id.toLowerCase() === want.toLowerCase() ? hit : null;
}

/** @param {unknown} v */
const named = (v) => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ") : null);

/**
 * One `providers` entry of model_data.json: either the plan as a bare string
 * ("Max 5x", "api") or `{plan, info}`, where `info` is a routing rule that
 * holds for every model of that provider ("no secrets" is about who runs the
 * servers, not about one model).
 *
 * @param {unknown} v
 * @returns {{plan: string|null, info: string|null}}
 */
export function providerEntry(v) {
  if (typeof v === "string") return { plan: named(v), info: null };
  if (v && typeof v === "object") {
    const o = /** @type {Record<string, unknown>} */ (v);
    return { plan: named(o.plan), info: named(o.info) };
  }
  return { plan: null, info: null };
}

/**
 * The owner's routing rules for one model: its provider's `info`, then its
 * own. Binding for the orchestrator, unlike anything measured.
 *
 * @param {string} id  opencode provider/model
 * @param {{note?: any, providers?: Record<string, unknown>|null}} [ctx]
 * @returns {string[]}
 */
export function ownerRules(id, { note, providers } = {}) {
  const provider = String(id).split("/")[0];
  return [providerEntry(providers?.[provider]).info, named(note?.info)].filter((r) => r !== null);
}

/**
 * How a model is paid for, as the orchestrator should read it. The plan name
 * is the user's own words ("Max 5x", "GLM Coding Pro") — models know what the
 * common plans include, so no catalog of limits is kept here to go stale.
 *
 * Precedence: the model's own `billing` in model_data.json, then the
 * provider's entry under `providers`, then what opencode's auth tells us
 * (an OAuth login is a subscription), then the provider's name
 * (`*-coding-plan` / `*-token-plan`). Anything else is metered API.
 *
 * @param {string} id  opencode provider/model
 * @param {{note?: any, plans?: Record<string, unknown>|null,
 *   authTypes?: Record<string, string>|null}} [ctx]
 * @returns {{api: true} | {api: false, plan: string|null}}
 */
export function billingFor(id, { note, plans, authTypes } = {}) {
  const provider = String(id).split("/")[0];
  /** @param {string} v @returns {{api: true} | {api: false, plan: string}} */
  const asPlan = (v) => (v.toLowerCase() === "api" ? { api: true } : { api: false, plan: v });
  const own = named(note?.billing);
  if (own) return own === "subscription" ? { api: false, plan: null } : asPlan(own);
  const plan = providerEntry(plans?.[provider]).plan;
  if (plan) return asPlan(plan);
  if (authTypes?.[provider] === "oauth") return { api: false, plan: null };
  if (/-(?:coding|token)-plan$/.test(provider)) return { api: false, plan: null };
  return { api: true };
}

/** @param {number} v */
const fmtVal = (v) => (Math.abs(v) >= 100 ? String(Math.round(v)) : String(Number(v.toFixed(3))));

/** @param {number|null|undefined} at  epoch ms @param {number} now */
function fmtAge(at, now) {
  if (typeof at !== "number") return "never";
  const h = Math.max(0, Math.round((now - at) / 3600_000));
  return h < 1 ? "<1h ago" : `${h}h ago`;
}

/**
 * When one key metric's rows were last fetched. Each metric is refreshed on
 * its own (a failed request keeps the old rows and their old age), so its
 * time lives in `fetchedAtByMetric`. A cache written before that has only
 * the block-wide `fetchedAt`, which stands for every metric it holds rows for.
 *
 * @param {MetricsData["scores"] | null | undefined} scores
 * @param {string} metric
 * @returns {number | undefined}  undefined: never fetched
 */
export function metricFetchedAt(scores, metric) {
  const own = scores?.fetchedAtByMetric?.[metric];
  if (typeof own === "number") return own;
  const legacy = scores?.fetchedAt;
  return typeof legacy === "number" && scores?.byMetric?.[metric] ? legacy : undefined;
}

/**
 * Age of the llmbenchmark rows the summary shows: the newest one, then every
 * metric whose rows are older than that, so a stale score is never passed off
 * as freshly fetched.
 *
 * @param {MetricsData["scores"] | null | undefined} scores
 * @param {number} now
 */
function fmtScoresAge(scores, now) {
  const ages = KEY_METRICS.flatMap(({ metric, label }) => {
    const at = metricFetchedAt(scores, metric);
    return typeof at === "number" ? [{ label, at, age: fmtAge(at, now) }] : [];
  });
  if (!ages.length) return fmtAge(undefined, now);
  const newest = ages.reduce((a, b) => (b.at > a.at ? b : a)).age;
  const older = ages.filter((a) => a.age !== newest).map((a) => `${a.label}: ${a.age}`);
  return older.length ? `${newest} (${older.join(", ")})` : newest;
}

/** Candidate ids, at most three named. @param {string[]} ids */
function fmtCandidates(ids) {
  const rest = ids.length - 3;
  return `${ids.slice(0, 3).join(", ")}${rest > 0 ? `, +${rest} more` : ""}`;
}

/** @param {Array<{value:number, setting:string|null}>} values */
function fmtValues(values) {
  if (values.length === 1) return fmtVal(values[0].value);
  return values.map((v) => `${fmtVal(v.value)}${v.setting ? ` (${v.setting})` : ""}`).join(" / ");
}

/**
 * @typedef {object} MetricsData
 * @property {{fetchedAt?: number, format?: number,
 *   index?: ReturnType<typeof indexSuperIndex>}} [superindex]
 *   no `format` (or another one): written by an earlier version; see superindexOf.
 * @property {{fetchedAt?: number, fetchedAtByMetric?: Record<string, number>,
 *   formatByMetric?: Record<string, number>,
 *   byMetric?: Record<string, ReturnType<typeof indexScoreRows>>}} [scores]
 *   `fetchedAt` is the single timestamp of the old cache format; see metricFetchedAt.
 *   A metric not at LLMBENCH_FORMAT in `formatByMetric` has rows of an earlier format.
 * @property {{fetchedAt?: number, format?: number,
 *   index?: Record<string, {id: string, candidates?: string[]}>}} [ids]
 *   an index without `format` maps keys to bare id strings and is not used.
 */

/**
 * The summary: one line per connected model. What belongs to the model itself
 * — context limit, how it is paid for, the owner's rules — is always on its
 * own line. Only benchmark data is shared: a serving tier (`-fast`, `-free`,
 * ...) whose scores are another listed model's says so instead of repeating
 * them, and a model with no benchmark data says that. Only a model with
 * nothing to show at all collapses into the single trailing line.
 *
 * @param {object} p
 * @param {Array<{id: string, context?: number}>} p.models  connected opencode models
 * @param {Record<string, string[]>} [p.roles]  model id -> ["grunt", "drill"]
 * @param {Record<string, any>|null} [p.notes]  model_data.json models
 * @param {Record<string, unknown>|null} [p.plans]  model_data.json providers
 * @param {Record<string, string>|null} [p.authTypes]  provider -> opencode auth type
 * @param {MetricsData|null} p.data
 * @param {number} p.now
 * @returns {string}
 */
export function formatSummary({
  models,
  roles = {},
  notes = null,
  plans = null,
  authTypes = null,
  data,
  now,
}) {
  const si = superindexOf(data);
  const byMetric = data?.scores?.byMetric ?? {};
  const header = [
    `Model metrics for ${models.length} model(s).`,
    `SuperIndex (superindex.app, CC-BY-4.0): fetched ${fmtAge(data?.superindex?.fetchedAt, now)}. ` +
      `llmbenchmark.ai: fetched ${fmtScoresAge(data?.scores, now)}.`,
    "SI = SuperIndex composite score (#rank). Benchmarks are 0-1, measured at the " +
      "setting the leaderboard ran (mostly max effort) — NOT at your agents' variant. " +
      "Where a model was run at several settings, all are listed. A benchmark missing " +
      "from a line was not measured for that model — it is not a zero. " +
      "Prices are SuperIndex list prices, $ per 1M tokens in/out: reference for metered " +
      "API, not necessarily what your provider bills. `subscription: <plan>` " +
      "is a flat-rate plan: ~$0 per token, bounded by the plan's usage limits instead.",
    `Benchmarks: ${KEY_METRICS.map((m) => m.label).join(", ")}. Every metric for up to ` +
      "6 models: squad_metrics({models: [...], full: true}).",
    "",
  ];
  if (si && data?.superindex?.format !== SUPERINDEX_FORMAT) {
    header.splice(
      -1,
      0,
      "The cached SuperIndex data predates exact-id matching: its list prices and context " +
        "limits are withheld until it is refetched; its scores are matched by model name only.",
    );
  }
  const legacy = KEY_METRICS.filter(
    ({ metric }) => byMetric[metric] && !currentRows(data?.scores, metric),
  ).map((m) => m.label);
  if (legacy.length) {
    header.splice(
      -1,
      0,
      `The cached llmbenchmark rows for ${legacy.join(", ")} predate exact-id matching ` +
        "and may pool models whose ids differ only in punctuation; they are refetched at the " +
        "next check.",
    );
  }
  if (!si && !Object.keys(byMetric).length) {
    header.push(
      "Metrics are unavailable right now (first fetch has not completed or both sources " +
        "failed). Route on the agent descriptions and say that metrics were unavailable.",
    );
  }

  const lines = [];
  const noData = [];
  // Benchmark rows already shown, by provider: a tier matching the same rows
  // points at the first model instead of repeating its numbers.
  /** @type {Map<string, string>} */
  const firstBySignature = new Map();
  for (const m of [...models].sort((a, b) => a.id.localeCompare(b.id))) {
    const note = notes?.[m.id];
    const s = lookup(m.id, si ?? {});
    // One llmbenchmark identity for every metric (#54); earlier-format
    // slices may only agree with it.
    const identity = resolveLlmbIdentity(m.id, data);
    const legacyIds = new Set(
      KEY_METRICS.filter(({ metric }) => byMetric[metric] && !currentRows(data?.scores, metric))
        .map(({ metric }) => lookup(m.id, byMetric[metric])?.entry)
        .filter((e) => e && !e.candidates)
        .map((e) => e?.id.toLowerCase()),
    );
    const legacyId = legacyIds.size === 1 ? ([...legacyIds][0] ?? null) : null;
    const hits = KEY_METRICS.map(({ metric }) =>
      sliceHit(
        m.id,
        byMetric[metric],
        Boolean(currentRows(data?.scores, metric)),
        identity,
        legacyId,
      ),
    );
    const rules = ownerRules(m.id, { note, providers: plans });
    const info = rules.length ? rules.join(" / ") : null;
    const role = roles[m.id]?.length ? ` [${roles[m.id].join("+")}]` : "";

    // The model's own facts. A list price read off another tier's row is that
    // tier's price, whether or not that model is in this request.
    const own = [];
    const facts = servingFacts(m.id, s?.entry ?? null, {
      context: m.context,
      note,
      plans,
      authTypes,
    });
    if (facts.ctx) own.push(facts.ctx);
    if (facts.billing) own.push(facts.billing);
    else if (facts.price) own.push(facts.price);
    const rule = info ? [`owner rule: ${info}`] : [];

    // Candidates only the model list holds: no metric to mark ambiguous, but
    // the uncertainty still belongs on the line, as in the full view.
    const listOnly =
      identity && "candidates" in identity && hits.every((h) => h === null)
        ? identity.candidates
        : null;
    if (!s && !listOnly && hits.every((h) => h === null)) {
      if (!own.length && !rule.length) noData.push(m.id);
      else lines.push(`- ${m.id}${role}: ${[...own, "no benchmark data", ...rule].join(" · ")}`);
      continue;
    }
    const provider = m.id.split("/")[0];
    // The SuperIndex row by id: two exact ids that normalize alike are two rows.
    const signature = `${provider}|${s?.entry.id ?? ""}|${hits
      .map((h) => h?.entry.candidates?.join(",") ?? h?.entry.id ?? "")
      .join("|")}|${listOnly?.join(",") ?? ""}`;
    const same = firstBySignature.get(signature);
    if (same) {
      lines.push(
        `- ${m.id}${role}: ${[...own, `same benchmarks as ${same}`, ...rule].join(" · ")}`,
      );
      continue;
    }
    firstBySignature.set(signature, m.id);

    const parts = [];
    if (s) {
      const e = s.entry;
      if (e.score === null) parts.push(`SI unranked (${e.status ?? "no score"})`);
      else if (e.rank !== null) parts.push(`SI ${e.score} #${e.rank}`);
      // Unranked scores rest on too few benchmarks to compare with ranked ones.
      else parts.push(`SI ${e.score} (provisional, conf ${e.confidence ?? "?"}%)`);
      // Several rows answer to this id: the score is the first one's.
      if (e.candidates) parts[parts.length - 1] += ` (ambiguous: ${fmtCandidates(e.candidates)})`;
    }
    parts.push(...own);
    hits.forEach((h, i) => {
      if (!h) return;
      // Several llmbenchmark ids answer to this key: name them, pool none.
      const c = h.entry.candidates;
      parts.push(
        `${KEY_METRICS[i].label} ${c ? `ambiguous (${fmtCandidates(c)})` : fmtValues(h.entry.values)}`,
      );
    });
    if (listOnly) parts.push(`llmbenchmark identity ambiguous (${fmtCandidates(listOnly)})`);
    const matched = [s?.key, listOnly ? identity?.key : null, ...hits.map((h) => h?.key)]
      .filter(Boolean)
      .find((k) => k !== modelKey(m.id));
    if (matched) parts.push(`(data for ${matched})`);
    parts.push(...rule);
    lines.push(`- ${m.id}${role}: ${parts.join(" · ")}`);
  }
  if (noData.length) lines.push(`- no benchmark data: ${noData.join(", ")}`);
  return [...header, ...lines].join("\n");
}

/**
 * Every score llmbenchmark holds for one model, grouped by source.
 *
 * @param {string} id  opencode id as asked
 * @param {any} detail  llmbenchmark /v1/models/{id} body (or null)
 * @param {SiEntry | null} si  matched row, from lookup(id, superindexOf(data))
 * @param {BillingContext & {context?: number|null, llmbCandidates?: string[]}} [opts]
 *   context: opencode catalog limit; llmbCandidates: llmbenchmark ids that all
 *   match (see resolveLlmbIdentity), none fetched; the rest is how the model is paid
 *   for, as the summary has it
 * @returns {string}
 */
export function formatDetail(id, detail, si, opts = {}) {
  const head = [`## ${id}`];
  if (si) {
    // A tier read off its base model's row, or a match several rows share:
    // say whose row it is.
    const own = ownsRow(id, modelKey(si.id));
    const whose = si.candidates
      ? ` (ambiguous match: ${si.candidates.join(", ")}; scores of ${si.id})`
      : own
        ? ""
        : ` (row of ${si.id})`;
    head.push(
      `SuperIndex${whose}: ` +
        `${si.score ?? "unscored"}${si.rank !== null ? ` (#${si.rank})` : ""}, ` +
        `status ${si.status ?? "?"}, confidence ${si.confidence ?? "?"}%`,
    );
  }
  // Context, billing and price as the summary shows them, never the base
  // row's for a tier. A list price is SuperIndex's, not what the user pays.
  const facts = servingFacts(id, si, opts);
  const price = facts.listed
    ? `SuperIndex list price ${facts.price} per 1M (reference${facts.billing ? ", not billed on this plan" : ""})`
    : facts.price;
  const serving = [facts.ctx, facts.billing, price].filter(Boolean);
  if (serving.length) head.push(`Serving: ${serving.join(" · ")}`);
  const scores = Array.isArray(detail?.scores) ? detail.scores : [];
  if (!scores.length) {
    const c = opts.llmbCandidates;
    head.push(
      c?.length
        ? `llmbenchmark: ambiguous match (${fmtCandidates(c)}); no one model's scores are shown.`
        : detail
          ? "llmbenchmark: no scores."
          : "llmbenchmark: not found or unavailable.",
    );
    return head.join("\n");
  }
  head.push(`llmbenchmark id: ${detail.id} (Artificial Analysis rows omitted)`);
  /** @type {Map<string, string[]>} */
  const bySource = new Map();
  for (const s of scores) {
    const value = num(s?.value);
    // Vote counts and confidence intervals describe a leaderboard's sample,
    // not the model; they would double the text and decide nothing.
    if (typeof s?.metric !== "string" || value === null || /_(?:votes|interval)$/.test(s.metric)) {
      continue;
    }
    if (EXCLUDED_SOURCES.has(s.source)) continue;
    const src = `${typeof s.source === "string" ? s.source : "?"}${s.setting ? ` (${s.setting})` : ""}`;
    const unit = s.unit && s.unit !== "ratio" ? ` ${s.unit}` : "";
    if (!bySource.has(src)) bySource.set(src, []);
    bySource.get(src)?.push(`${s.metric}=${fmtVal(value)}${unit}`);
  }
  for (const [src, items] of [...bySource].sort((a, b) => a[0].localeCompare(b[0]))) {
    head.push(`${src}: ${items.join("; ")}`);
  }
  return head.join("\n");
}

/**
 * model id -> the squad roles it holds, from the agent list.
 *
 * @param {Array<{name: string, model?: {providerID: string, modelID: string}}>|null} agents
 * @returns {Record<string, string[]>}
 */
export function squadRoles(agents) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const a of Array.isArray(agents) ? agents : []) {
    const role = squadRoleOf(a?.name);
    if (!role || !a.model) continue;
    const id = `${a.model.providerID}/${a.model.modelID}`;
    out[id] ??= [];
    if (!out[id].includes(role)) out[id].push(role);
  }
  return out;
}
