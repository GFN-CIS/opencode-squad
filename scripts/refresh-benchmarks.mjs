#!/usr/bin/env node
// Refresh the static model-benchmark snapshot (src/benchmarks.json) from
// Artificial Analysis. Run manually when you want fresh numbers — opencode does
// NOT expose benchmarks, and AA data is the only API source we found.
//
// Usage:
//   AA_API_KEY=aa_... node scripts/refresh-benchmarks.mjs          # fetch live
//   node scripts/refresh-benchmarks.mjs --from /tmp/aa.json        # from raw dump
//
// Covers ALL AA-scored models (every creator — anthropic, openai, google,
// alibaba, zai/GLM, kimi, deepseek, …), keyed by AA slug. Lookup from an
// opencode `provider/model` id is done in src/benchmarks.js.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkSnapshot, SCHEMA_VERSION } from "../src/benchmarks-schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "..", "src", "benchmarks.json");
// The legacy /api/v2/data/llms/models was retired on 2026-11-04 (HTTP 410).
// Pro keys get per-benchmark scores and the blended price; a Free key gets a
// 403 on the Pro list and falls back to /free (headline indices only).
const ENDPOINT = "https://artificialanalysis.ai/api/v2/language/models";
const ENDPOINT_FREE = `${ENDPOINT}/free`;
const MAX_PAGES = 50;

// Coverage floor. Intelligence Index v5 (2026-10-27) nulls the index for
// models AA has not re-evaluated yet; a snapshot generation that scores fewer
// models than this is a truncated/reshaped AA response, not a migration.
const MIN_SCORED = 50;

const num = (v) => (typeof v === "number" ? v : null);

function transform(rawData) {
  /** @type {Record<string, any>} */
  const models = {};
  let scored = 0;
  for (const x of rawData) {
    const ev = x.evaluations || {};
    const intelligence = num(ev.artificial_analysis_intelligence_index);
    if (intelligence == null) continue; // keep only AA-scored models
    scored++;
    const pr = x.pricing || {};
    const perf = x.performance || {};
    const priceIn = num(pr.price_1m_input_tokens);
    const priceOut = num(pr.price_1m_output_tokens);
    // Free tier has no blended price; derive AA's 3:1 blend from its parts.
    const blended =
      num(pr.price_1m_blended_3_to_1) ??
      (priceIn != null && priceOut != null
        ? Math.round(((3 * priceIn + priceOut) / 4) * 1000) / 1000
        : null);
    models[x.slug] = {
      name: x.name,
      // The language API's model_creator carries id/name only, no slug.
      creator: x.model_creator?.slug ?? null,
      release_date: x.release_date ?? null,
      // headline indices
      intelligence,
      coding: num(ev.artificial_analysis_coding_index),
      math: num(ev.artificial_analysis_math_index),
      // agentic / tool-use benchmarks (no single "agentic index" in the API)
      agentic: {
        tau2: num(ev.tau2_telecom ?? ev.tau2),
        tau_banking: num(ev.tau_banking),
        terminalbench_hard: num(ev.terminalbench_hard),
        terminalbench_v2_1: num(ev.terminalbench_v2_1),
        terminalbench_v4_0: num(ev.terminalbench_v4_0),
        lcr: num(ev.aa_lcr ?? ev.lcr),
      },
      // the rest of the eval suite
      benchmarks: {
        gpqa: num(ev.gpqa_diamond ?? ev.gpqa),
        hle: num(ev.hle),
        livecodebench: num(ev.livecodebench),
        scicode: num(ev.scicode),
        mmlu_pro: num(ev.mmlu_pro),
        math_500: num(ev.math_500),
        aime: num(ev.aime),
        aime_25: num(ev.aime_25),
        ifbench: num(ev.ifbench),
      },
      // cost (AA has no "cost per task"; blended $/1M is the cost proxy)
      price_blended: blended,
      price_input: priceIn,
      price_output: priceOut,
      // speed
      tps: num(perf.median_output_tokens_per_second ?? x.median_output_tokens_per_second),
      ttft: num(perf.median_time_to_first_token_seconds ?? x.median_time_to_first_token_seconds),
    };
  }
  return { models, scored };
}

async function loadRaw(argv) {
  const fromIdx = argv.indexOf("--from");
  if (fromIdx !== -1) {
    const file = argv[fromIdx + 1];
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  const key = process.env.AA_API_KEY;
  if (!key) {
    console.error("No AA_API_KEY in env and no --from <file>. Set AA_API_KEY or pass a raw dump.");
    process.exit(2);
  }
  let endpoint = ENDPOINT;
  let first = await fetchPage(endpoint, 1, key);
  if (first.status === 403) {
    console.log("Pro list forbidden for this key; using the Free list.");
    endpoint = ENDPOINT_FREE;
    first = await fetchPage(endpoint, 1, key);
  }
  if (!first.ok) fail(first);
  const body = await first.json();
  const data = [...body.data];
  for (let page = 2; body.pagination?.has_more && page <= MAX_PAGES; page++) {
    const res = await fetchPage(endpoint, page, key);
    if (!res.ok) fail(res);
    const next = await res.json();
    data.push(...next.data);
    if (!next.pagination?.has_more) break;
  }
  console.log(`Fetched ${data.length} models from ${endpoint} (tier ${body.tier ?? "?"}).`);
  return { data, endpoint };
}

/** @param {string} endpoint @param {number} page @param {string} key */
function fetchPage(endpoint, page, key) {
  return fetch(`${endpoint}?page=${page}`, { headers: { "x-api-key": key } });
}

/** @param {Response} res @returns {never} */
function fail(res) {
  console.error(`AA API ${res.status} ${res.statusText} (${res.url})`);
  process.exit(1);
}

async function main() {
  const raw = await loadRaw(process.argv.slice(2));
  const data = raw.data || raw;
  const { models, scored } = transform(data);
  // Producer-side guard only (checkSnapshot is also used by the plugin to
  // validate downloads, so the floor must not live there).
  if (scored < MIN_SCORED) {
    console.error(
      `AA returned ${scored} scored models (< ${MIN_SCORED}) — refusing to overwrite snapshot`,
    );
    process.exit(1);
  }
  const snapshot = {
    _meta: {
      schema: SCHEMA_VERSION,
      intelligence_index: "v5",
      source: "artificialanalysis.ai",
      endpoint: raw.endpoint ?? ENDPOINT,
      generated: new Date().toISOString().slice(0, 10),
      model_count: scored,
      note: "Keyed by AA slug. Map an opencode provider/model id via src/benchmarks.js. Intelligence Index v5 (since 2026-10-27): AA re-scored only recent models — the rest are null and dropped until re-evaluated. Indices ~0-100; price is $/1M blended (3:1). No native agentic index — see agentic.* benchmarks (Pro tier only). AA no longer publishes a Coding Index, so coding is null. No cost-per-task — price_blended is the proxy.",
    },
    models,
  };
  // Validate before writing: a reshaped AA response must fail here (and fail
  // the CI refresh) rather than land on master, where installed plugins fetch it.
  const check = checkSnapshot(snapshot);
  if (!check.ok) {
    console.error(`Snapshot failed schema v${SCHEMA_VERSION} validation: ${check.error}`);
    process.exit(1);
  }
  fs.writeFileSync(OUT, `${JSON.stringify(snapshot, null, 1)}\n`);
  console.log(`Wrote ${OUT}: ${scored} scored models.`);
}

main();
