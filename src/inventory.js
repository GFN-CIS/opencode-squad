// Pure formatting of the subagent inventory for the orchestrator bootstrap.

import { formatBench } from "./benchmarks.js";

const fmtCtx = (n) =>
  n >= 1_000_000 ? `${Math.round(n / 1e5) / 10}M` : `${Math.round(n / 1000)}k`;

/**
 * @param {Array<{name:string,mode:string,description?:string,model?:{providerID:string,modelID:string}}>} agents
 * @param {Record<string, any>} [benchmarks] the `models` object from benchmarks.json;
 *        when given, each subagent line gets a minimal AA capability summary
 *        (intel / code / agentic / $) for routing — no raw sub-benchmarks.
 * @param {Record<string, number>} [limits] providerID/modelID -> context window
 *        (from opencode; AA has no context). Adds `ctx <window>` per line.
 * @returns {string}
 */
export function formatInventory(agents, benchmarks, limits) {
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
      const bench = benchmarks && a.model ? formatBench(model, benchmarks) : null;
      const benchStr = bench ? ` — ${bench}` : "";
      return `- \`${a.name}\`: ${desc} (model: ${model}${ctxStr}${benchStr})`;
    })
    .join("\n");
}
