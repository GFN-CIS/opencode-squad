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
// matching ignores the provider and compares the normalized model part.

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

// Serving-speed and pricing-tier suffixes that name the same weights.
const SAME_MODEL_SUFFIXES = [
  /-ultrafast$/,
  /-highspeed$/,
  /-fast$/,
  /-free$/,
  /-latest$/,
  /-preview$/,
  /-\d{8}$/,
];

/** @param {string} id  "provider/model" or bare "model" */
function modelKey(id) {
  const s = String(id);
  const model = s.includes("/") ? s.slice(s.indexOf("/") + 1) : s;
  return model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Keys to try for an opencode id, exact first. Only suffixes that keep the
 * same weights are stripped — `glm-5.3` never matches `glm-5.3-flash`.
 *
 * @param {string} id
 * @returns {string[]}
 */
export function keyCandidates(id) {
  const out = [];
  const add = (k) => {
    if (k && !out.includes(k)) out.push(k);
  };
  const base = modelKey(id);
  add(base);
  let k = base;
  for (let changed = true; changed; ) {
    changed = false;
    for (const re of SAME_MODEL_SUFFIXES) {
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
 * @template T
 * @param {string} id
 * @param {Record<string, T>} index  keyed by modelKey
 * @returns {{key: string, entry: T} | null}
 */
export function lookup(id, index) {
  if (!index) return null;
  for (const key of keyCandidates(id)) {
    if (Object.hasOwn(index, key)) return { key, entry: index[key] };
  }
  return null;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * SuperIndex models.json -> compact index keyed by modelKey.
 *
 * @param {any} json
 * @returns {Record<string, {id: string, score: number|null, rank: number|null,
 *   status: string|null, confidence: number|null, priceIn: number|null,
 *   priceOut: number|null, context: number|null}>}
 */
export function indexSuperIndex(json) {
  const out = {};
  for (const m of Array.isArray(json?.models) ? json.models : []) {
    if (typeof m?.id !== "string") continue;
    const key = modelKey(m.id);
    if (out[key]) continue;
    out[key] = {
      id: m.id,
      score: num(m.si_score),
      rank: num(m.rank),
      status: typeof m.status === "string" ? m.status : null,
      confidence: num(m.confidence_pct),
      priceIn: num(m.price_in),
      priceOut: num(m.price_out),
      context: num(m.context_window),
    };
  }
  return out;
}

/**
 * llmbenchmark /v1/scores rows for one metric -> {modelKey: [{value, setting}]}.
 * Rows for the same model at different settings are all kept: collapsing to
 * the best one would quietly report a max-effort number for every model.
 *
 * @param {any} rows
 * @returns {Record<string, {id: string, values: Array<{value: number, setting: string|null}>}>}
 */
export function indexScoreRows(rows) {
  const out = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    const value = num(r?.value);
    if (typeof r?.modelId !== "string" || value === null) continue;
    const key = modelKey(r.modelId);
    out[key] ??= { id: r.modelId, values: [] };
    out[key].values.push({ value, setting: typeof r.setting === "string" ? r.setting : null });
  }
  return out;
}

/**
 * llmbenchmark /v1/models list -> {modelKey: llmbenchmark id}, so a model with
 * no key-metric rows can still be looked up for its full detail.
 *
 * @param {any} list
 * @returns {Record<string, string>}
 */
export function indexModelIds(list) {
  const out = {};
  for (const m of Array.isArray(list) ? list : []) {
    if (typeof m?.id !== "string") continue;
    const key = modelKey(m.id);
    out[key] ??= m.id;
  }
  return out;
}

/**
 * Flat-rate billing: the user's explicit `billing` in model_data.json wins;
 * otherwise a `*-coding-plan` / `*-token-plan` provider is a subscription by
 * construction.
 *
 * @param {string} id  opencode provider/model
 * @param {any} [note]  model_data.json entry
 */
export function isSubscription(id, note) {
  if (note?.billing === "subscription") return true;
  if (typeof note?.billing === "string" && note.billing) return false;
  const provider = String(id).split("/")[0];
  return /-(?:coding|token)-plan$/.test(provider);
}

const fmtCtx = (n) =>
  n >= 1_000_000 ? `${Math.round(n / 1e5) / 10}M` : `${Math.round(n / 1000)}k`;

const fmtVal = (v) => (Math.abs(v) >= 100 ? String(Math.round(v)) : String(Number(v.toFixed(3))));

/** @param {number|null|undefined} at  epoch ms */
function fmtAge(at, now) {
  if (typeof at !== "number") return "never";
  const h = Math.max(0, Math.round((now - at) / 3600_000));
  return h < 1 ? "<1h ago" : `${h}h ago`;
}

/** @param {Array<{value:number, setting:string|null}>} values */
function fmtValues(values) {
  if (values.length === 1) return fmtVal(values[0].value);
  return values.map((v) => `${fmtVal(v.value)}${v.setting ? ` (${v.setting})` : ""}`).join(" / ");
}

/**
 * @typedef {object} MetricsData
 * @property {{fetchedAt?: number, index?: ReturnType<typeof indexSuperIndex>}} [superindex]
 * @property {{fetchedAt?: number, byMetric?: Record<string, ReturnType<typeof indexScoreRows>>}} [scores]
 * @property {{fetchedAt?: number, index?: Record<string, string>}} [ids]
 */

/**
 * The summary: one line per connected model. Models with no data in either
 * source collapse into a single trailing line.
 *
 * @param {object} p
 * @param {Array<{id: string, context?: number}>} p.models  connected opencode models
 * @param {Record<string, string[]>} [p.roles]  model id -> ["grunt", "drill"]
 * @param {Record<string, any>|null} [p.notes]  model_data.json models
 * @param {MetricsData|null} p.data
 * @param {number} p.now
 * @returns {string}
 */
export function formatSummary({ models, roles = {}, notes = null, data, now }) {
  const si = data?.superindex?.index;
  const byMetric = data?.scores?.byMetric ?? {};
  const header = [
    `Model metrics for the ${models.length} models connected in opencode.`,
    `SuperIndex (superindex.app, CC-BY-4.0): fetched ${fmtAge(data?.superindex?.fetchedAt, now)}. ` +
      `llmbenchmark.ai: fetched ${fmtAge(data?.scores?.fetchedAt, now)}.`,
    "SI = SuperIndex composite score (#rank). Benchmarks are 0-1, measured at the " +
      "setting the leaderboard ran (mostly max effort) — NOT at your agents' variant. " +
      "Where a model was run at several settings, all are listed. A benchmark missing " +
      "from a line was not measured for that model — it is not a zero. " +
      "Prices are list $ per 1M tokens in/out; a subscription model costs ~$0 at the margin.",
    `Benchmarks: ${KEY_METRICS.map((m) => m.label).join(", ")}. Every metric for given ` +
      "models: squad_metrics({models: [...]}).",
    "",
  ];
  if (!si && !Object.keys(byMetric).length) {
    header.push(
      "Metrics are unavailable right now (first fetch has not completed or both sources " +
        "failed). Route on the agent descriptions and say that metrics were unavailable.",
    );
  }

  const lines = [];
  const noData = [];
  // A serving tier (`-fast`, `-free`, ...) of a model already listed under the
  // same provider carries the same numbers: one short line instead of a copy.
  /** @type {Map<string, string>} */
  const firstBySignature = new Map();
  for (const m of [...models].sort((a, b) => a.id.localeCompare(b.id))) {
    const note = notes?.[m.id];
    const s = lookup(m.id, si);
    const hits = KEY_METRICS.map(({ metric }) => lookup(m.id, byMetric[metric]));
    const info = typeof note?.info === "string" && note.info.trim() ? note.info.trim() : null;
    const role = roles[m.id]?.length ? ` [${roles[m.id].join("+")}]` : "";
    if (!s && hits.every((h) => h === null) && !info) {
      noData.push(m.id);
      continue;
    }
    const provider = m.id.split("/")[0];
    const signature = `${provider}|${s?.key ?? ""}|${hits.map((h) => h?.key ?? "").join("|")}`;
    const same = firstBySignature.get(signature);
    if (same && !info) {
      lines.push(`- ${m.id}${role}: same data as ${same}`);
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
    }
    const ctx = m.context ?? s?.entry.context;
    if (ctx) parts.push(`ctx ${fmtCtx(ctx)}`);
    if (isSubscription(m.id, note)) parts.push("billing: subscription");
    else if (/-free$/.test(modelKey(m.id))) parts.push("free");
    else if (s?.entry.priceIn != null) {
      parts.push(`$${s.entry.priceIn}/$${s.entry.priceOut ?? "?"}`);
    }
    hits.forEach((h, i) => {
      if (h) parts.push(`${KEY_METRICS[i].label} ${fmtValues(h.entry.values)}`);
    });
    const matched = [s?.key, ...hits.map((h) => h?.key)]
      .filter(Boolean)
      .find((k) => k !== modelKey(m.id));
    if (matched) parts.push(`(data for ${matched})`);
    if (info) parts.push(`note: ${info}`);
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
 * @param {ReturnType<typeof indexSuperIndex>[string] | null} si
 * @returns {string}
 */
export function formatDetail(id, detail, si) {
  const head = [`## ${id}`];
  if (si) {
    head.push(
      `SuperIndex: ${si.score ?? "unscored"}${si.rank !== null ? ` (#${si.rank})` : ""}, ` +
        `status ${si.status ?? "?"}, confidence ${si.confidence ?? "?"}%, ` +
        `$${si.priceIn ?? "?"}/$${si.priceOut ?? "?"} per 1M, ctx ${si.context ? fmtCtx(si.context) : "?"}`,
    );
  }
  const scores = Array.isArray(detail?.scores) ? detail.scores : [];
  if (!scores.length) {
    head.push(detail ? "llmbenchmark: no scores." : "llmbenchmark: not found or unavailable.");
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
 * Every model opencode can reach, with its context window when known.
 *
 * @param {Array<{id: string, models?: Record<string, {limit?: {context?: number}}>}>|null} providers
 *   normalizeProviders output
 * @returns {Array<{id: string, context?: number}>}
 */
export function connectedModels(providers) {
  const out = [];
  for (const p of Array.isArray(providers) ? providers : []) {
    for (const [mid, m] of Object.entries(p?.models ?? {})) {
      const ctx = m?.limit?.context;
      out.push({
        id: `${p.id}/${mid}`,
        ...(typeof ctx === "number" && ctx > 0 ? { context: ctx } : {}),
      });
    }
  }
  return out;
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
    const role = /^(grunt|drill)-/.exec(a?.name ?? "")?.[1];
    if (!role || !a.model) continue;
    const id = `${a.model.providerID}/${a.model.modelID}`;
    out[id] ??= [];
    if (!out[id].includes(role)) out[id].push(role);
  }
  return out;
}
