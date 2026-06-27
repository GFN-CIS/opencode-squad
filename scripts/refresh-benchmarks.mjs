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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "..", "src", "benchmarks.json");
const ENDPOINT = "https://artificialanalysis.ai/api/v2/data/llms/models";

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
    models[x.slug] = {
      name: x.name,
      creator: (x.model_creator || {}).slug ?? null,
      release_date: x.release_date ?? null,
      // headline indices
      intelligence,
      coding: num(ev.artificial_analysis_coding_index),
      math: num(ev.artificial_analysis_math_index),
      // agentic / tool-use benchmarks (no single "agentic index" in the API)
      agentic: {
        tau2: num(ev.tau2),
        tau_banking: num(ev.tau_banking),
        terminalbench_hard: num(ev.terminalbench_hard),
        terminalbench_v2_1: num(ev.terminalbench_v2_1),
        lcr: num(ev.lcr),
      },
      // the rest of the eval suite
      benchmarks: {
        gpqa: num(ev.gpqa),
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
      price_blended: num(pr.price_1m_blended_3_to_1),
      price_input: num(pr.price_1m_input_tokens),
      price_output: num(pr.price_1m_output_tokens),
      // speed
      tps: num(x.median_output_tokens_per_second),
      ttft: num(x.median_time_to_first_token_seconds),
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
    console.error(
      "No AA_API_KEY in env and no --from <file>. Set AA_API_KEY or pass a raw dump.",
    );
    process.exit(2);
  }
  const res = await fetch(ENDPOINT, { headers: { "x-api-key": key } });
  if (!res.ok) {
    console.error(`AA API ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  return res.json();
}

async function main() {
  const raw = await loadRaw(process.argv.slice(2));
  const data = raw.data || raw;
  const { models, scored } = transform(data);
  const snapshot = {
    _meta: {
      source: "artificialanalysis.ai",
      endpoint: ENDPOINT,
      generated: new Date().toISOString().slice(0, 10),
      model_count: scored,
      note: "Keyed by AA slug. Map an opencode provider/model id via src/benchmarks.js. Indices ~0-100; price is $/1M blended (3:1). No native agentic index — see agentic.* benchmarks. No cost-per-task — price_blended is the proxy.",
    },
    models,
  };
  fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 1) + "\n");
  console.log(`Wrote ${OUT}: ${scored} scored models.`);
}

main();
