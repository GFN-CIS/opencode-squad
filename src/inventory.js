// Pure formatting of the subagent inventory for the orchestrator bootstrap.

import { formatBench } from "./benchmarks.js";

/**
 * @param {Array<{name:string,mode:string,description?:string,model?:{providerID:string,modelID:string}}>} agents
 * @param {Record<string, any>} [benchmarks] the `models` object from benchmarks.json;
 *        when given, each subagent line gets a minimal AA capability summary
 *        (intel / code / agentic / $) for routing — no raw sub-benchmarks.
 * @returns {string}
 */
export function formatInventory(agents, benchmarks) {
  const subagents = (agents || []).filter((a) => a && a.mode === "subagent");
  if (subagents.length === 0) return "(no subagents available)";
  return subagents
    .map((a) => {
      const desc = a.description || "(no description)";
      const model = a.model
        ? `${a.model.providerID}/${a.model.modelID}`
        : "inherited";
      const bench = benchmarks && a.model ? formatBench(model, benchmarks) : null;
      const tail = bench ? ` — ${bench}` : "";
      return `- \`${a.name}\`: ${desc} (model: ${model}${tail})`;
    })
    .join("\n");
}
