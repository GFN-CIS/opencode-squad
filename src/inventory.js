// Pure formatting of the subagent inventory for the orchestrator bootstrap.

const fmtCtx = (n) =>
  n >= 1_000_000 ? `${Math.round(n / 1e5) / 10}M` : `${Math.round(n / 1000)}k`;

/**
 * @param {Array<{name:string,mode:string,description?:string,model?:{providerID:string,modelID:string}}>} agents
 * No benchmarks or prices here on purpose: they change daily, and this block
 * is re-sent every turn. The squad_metrics tool serves them once per chat.
 *
 * @param {Record<string, number>} [limits] providerID/modelID -> context window
 *        (from opencode). Adds `ctx <window>` per line.
 * @returns {string}
 */
export function formatInventory(agents, limits) {
  const subagents = (agents || []).filter((a) => a && a.mode === "subagent");
  if (subagents.length === 0) return "(no subagents available)";
  return subagents
    .map((a) => {
      const desc = a.description || "(no description)";
      const model = a.model ? `${a.model.providerID}/${a.model.modelID}` : "inherited";
      const ctx = limits && a.model ? (limits[model] ?? limits[a.model.modelID]) : undefined;
      const ctxStr = typeof ctx === "number" && ctx > 0 ? ` · ctx ${fmtCtx(ctx)}` : "";
      return `- \`${a.name}\`: ${desc} (model: ${model}${ctxStr})`;
    })
    .join("\n");
}

/**
 * Whether a per-model squad has actually been drafted (squad-draft has run at
 * least once). There is no bundled grunt/drill fallback — if this is false,
 * the bootstrap must tell the user to draft one instead of routing to a
 * subagent that doesn't exist.
 *
 * @param {Array<{name:string}>} agents
 * @returns {boolean}
 */
export function hasSquad(agents) {
  return (agents || []).some((a) => a && /^(?:grunt|drill)-/.test(a.name));
}
