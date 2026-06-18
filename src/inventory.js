// Pure formatting of the subagent inventory for the orchestrator bootstrap.

/**
 * @param {Array<{name:string,mode:string,description?:string,model?:{providerID:string,modelID:string}}>} agents
 * @returns {string}
 */
export function formatInventory(agents) {
  const subagents = (agents || []).filter((a) => a && a.mode === "subagent");
  if (subagents.length === 0) return "(no subagents available)";
  return subagents
    .map((a) => {
      const desc = a.description || "(no description)";
      const model = a.model
        ? `${a.model.providerID}/${a.model.modelID}`
        : "inherited";
      return `- \`${a.name}\`: ${desc} (model: ${model})`;
    })
    .join("\n");
}
