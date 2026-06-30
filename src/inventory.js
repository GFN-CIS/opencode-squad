// Pure formatting of the subagent inventory for the orchestrator bootstrap.

import { formatBench } from "./benchmarks.js";

const fmtCtx = (n) =>
  n >= 1_000_000 ? `${Math.round(n / 1e5) / 10}M` : `${Math.round(n / 1000)}k`;

/**
 * @param {Array<{name:string,mode:string,description?:string,model?:{providerID:string,modelID:string}}>} agents
 * @param {((modelId:string)=>string|null) | Record<string, any>} [perf] perf
 *        source for the capability tail. Either a lookup function
 *        `(modelId) => "AA intel … · note: …"|null` (preferred — fed from
 *        model_data.json, with a benchmarks fallback baked in by the caller),
 *        OR the legacy AA `models` object, in which case `formatBench` does the
 *        AA-slug lookup directly.
 * @param {Record<string, number>} [limits] providerID/modelID -> context window
 *        (from opencode; AA has no context). Adds `ctx <window>` per line.
 * @returns {string}
 */
export function formatInventory(agents, perf, limits) {
  const subagents = (agents || []).filter((a) => a && a.mode === "subagent");
  if (subagents.length === 0) return "(no subagents available)";
  return subagents
    .map((a) => {
      const desc = a.description || "(no description)";
      const model = a.model
        ? `${a.model.providerID}/${a.model.modelID}`
        : "inherited";
      const ctx =
        limits && a.model
          ? limits[model] ?? limits[a.model.modelID]
          : undefined;
      const ctxStr = typeof ctx === "number" && ctx > 0 ? ` · ctx ${fmtCtx(ctx)}` : "";
      const bench = !a.model
        ? null
        : typeof perf === "function"
          ? perf(model)
          : perf
            ? formatBench(model, perf)
            : null;
      const benchStr = bench ? ` — ${bench}` : "";
      return `- \`${a.name}\`: ${desc} (model: ${model}${ctxStr}${benchStr})`;
    })
    .join("\n");
}
