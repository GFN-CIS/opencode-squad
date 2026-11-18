// OpenCode 2 payloads -> the shapes the pure squad modules were written for.
//
// The internal decision models use agent names, keyed provider models and
// `{info}` usage records. Normalize host payloads at the edge so the pure
// decision logic stays independent of transport details. Fixtures were captured
// on OpenCode 2.1.3 — see tests/v2-adapt.test.js.

import { BOOTSTRAP_MARKER, buildBootstrap } from "../bootstrap.js";
import { applySystemPromptTransform } from "../prompt-inject.js";

/**
 * Agent.Info[] -> internal agent list. The host's `name` is a display name
 * ("Build"); match on its id (`grunt-…`/`drill-…`) instead.
 *
 * @param {readonly any[]} agents
 * @returns {Array<{name: string, mode: string, description?: string, model?: {providerID: string, modelID: string}}>}
 */
export function normalizeAgents(agents) {
  if (!Array.isArray(agents)) return [];
  return agents
    .filter((a) => a && typeof a.id === "string")
    .map((a) => ({
      name: a.id,
      mode: a.mode,
      ...(a.description ? { description: a.description } : {}),
      ...(a.model?.providerID && a.model?.id
        ? { model: { providerID: a.model.providerID, modelID: a.model.id } }
        : {}),
    }));
}

/**
 * Model.Info[] (ctx.model.list) -> provider list as buildLimitMap and
 * buildVariantMap read it: `[{id, models: {[modelID]: {limit, variants}}}]`.
 * Host variants are `[{id, settings}]`; normalize them to a keyed object.
 *
 * @param {readonly any[]} models
 */
export function normalizeProviders(models) {
  /** @type {Map<string, {id: string, models: Record<string, object>}>} */
  const byProvider = new Map();
  for (const m of Array.isArray(models) ? models : []) {
    if (!m?.providerID || !m?.id) continue;
    const provider = byProvider.get(m.providerID) ?? { id: m.providerID, models: {} };
    provider.models[m.id] = {
      ...(m.limit ? { limit: m.limit } : {}),
      variants: Object.fromEntries(
        (Array.isArray(m.variants) ? m.variants : [])
          .filter((v) => typeof v?.id === "string")
          .map((v) => [v.id, v.settings ?? {}]),
      ),
    };
    byProvider.set(m.providerID, provider);
  }
  return [...byProvider.values()];
}

/**
 * SessionMessageInfo[] (ctx.session.context) -> internal `{info}` items carrying
 * what estimateContextTokens and the task-outcome scan read off assistant
 * messages: role, time, finish, tokens, model.
 *
 * @param {readonly any[]} messages
 */
export function normalizeUsageMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m?.type === "assistant" || m?.type === "user")
    .map((m) => ({
      info: {
        role: m.type,
        time: m.time,
        ...(m.type === "assistant"
          ? {
              finish: m.finish,
              tokens: m.tokens,
              modelID: m.model?.id,
              providerID: m.model?.providerID,
            }
          : {}),
      },
    }));
}

/**
 * Role-prompt refresh on V2's `SystemPart[]`. The agent's own prompt is the
 * text of the first part (verified live for a subagent session), so the prompt
 * transform runs on the first text part that carries a fence.
 *
 * @param {Array<{type?: string, text?: string}>} system
 * @param {(role: string) => string | null} loadPrompt
 */
export function applySystemPartsTransform(system, loadPrompt) {
  if (!Array.isArray(system)) return { applied: false };
  const part = system.find(
    (p) => p?.type === "text" && typeof p.text === "string" && p.text.includes("squad:prompt"),
  );
  if (!part) return { applied: false };
  const holder = [part.text];
  const result = applySystemPromptTransform(holder, loadPrompt);
  if (result.changed) part.text = holder[0];
  return result;
}

/**
 * The `retry` hook event -> the retry status object evaluateRetry
 * reads. `next` is the absolute wake-up time OpenCode is proposing.
 *
 * @param {{attempt: number, error?: {message?: string}, decision: {retry: boolean, delay?: number}}} event
 * @param {number} now
 */
export function retryToStatus(event, now) {
  const delay = event?.decision?.retry ? Number(event.decision.delay) || 0 : 0;
  return {
    type: "retry",
    attempt: event?.attempt,
    message: event?.error?.message ?? "",
    next: now + Math.max(0, delay),
  };
}

/**
 * The orchestrator bootstrap, appended to the system prompt of the orchestrator
 * agent's requests.
 *
 * WHY the system prompt and not a message. The block used to be injected into
 * the latest user message on every request and never persisted. Every prompt
 * cache entry past the system prompt therefore contained some user message WITH
 * the block, and on the next user turn that message went back to its bare
 * text: nothing past the system prompt could ever be read back. Measured over
 * 14 days of orchestrator sessions: the first call of every warm user turn read
 * only the ~23k system prefix and re-wrote the whole conversation, ~$299 of
 * $869. The block changes only with the squad (inventory) or the model, so in
 * the system prompt it is cached once with the rest of it, and the messages
 * are never touched. The clock and the context size it used to carry come from
 * the squad_session tool instead.
 *
 * @param {{agent: string, model?: {providerID?: string, id?: string}, system?: any[]}} event
 *   the `context` hook event (mutated in place)
 * @param {object} opts
 * @param {string} opts.orchestratorAgent
 * @param {() => Promise<string>} opts.getInventory
 * @param {() => boolean} opts.getHasSquad called after getInventory resolves
 */
export async function applyOrchestratorTransformV2(event, opts) {
  if (event?.agent !== opts.orchestratorAgent || !Array.isArray(event.system)) return;
  if (
    event.system.some(
      (p) => p?.type === "text" && typeof p.text === "string" && p.text.includes(BOOTSTRAP_MARKER),
    )
  ) {
    return;
  }
  const inventory = await opts.getInventory();
  const modelText =
    event.model?.providerID && event.model?.id
      ? `${event.model.providerID}/${event.model.id}`
      : null;
  event.system.push({
    type: "text",
    text: buildBootstrap(inventory, { modelText, hasSquad: opts.getHasSquad() }),
  });
}
