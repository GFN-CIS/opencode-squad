// OpenCode 2 payloads -> the shapes the pure squad modules were written for.
//
// The internal decision models use agent names, keyed provider models and
// `{info}` usage records. Normalize host payloads at the edge so the pure
// decision logic stays independent of transport details. Fixtures were captured
// on OpenCode 2.1.3 — see tests/v2-adapt.test.js.

import { BOOTSTRAP_MARKER, buildBootstrap } from "../bootstrap.js";
import {
  DEFAULT_LIMIT,
  estimateContextTokens,
  formatContextLine,
  formatLocalDateTime,
} from "../context.js";
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
 * The subagent's model, read off its newest assistant message (V2 keeps it
 * nowhere else a plugin can reach).
 *
 * @param {readonly any[]} messages V2 SessionMessageInfo[]
 * @returns {{providerID: string, modelID: string} | null}
 */
export function lastAssistantModel(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.type === "assistant" && m.model?.providerID && m.model?.id) {
      return { providerID: m.model.providerID, modelID: m.model.id };
    }
  }
  return null;
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
 * A copy of a V2 tool result with `text` appended as its own paragraph.
 * @param {any} result
 * @param {string} text
 */
export function appendToResult(result, text) {
  const content = result?.content;
  if (Array.isArray(content)) {
    return { ...result, content: [...content, { type: "text", text }] };
  }
  const base = typeof content === "string" ? content : "";
  return { ...result, content: base ? `${base}\n\n${text}` : text };
}

/**
 * What the V2 `subagent` tool returned, in the terms the task-outcome and
 * cache-status code use: the child session id and the subagent's final text.
 *
 * @param {any} result
 * @returns {{sessionID?: string, output: string}}
 */
export function subagentOutcome(result) {
  const sessionID = result?.metadata?.sessionID ?? result?.output?.sessionID;
  const text = result?.output?.output;
  return { sessionID, output: typeof text === "string" ? text : "" };
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
 * The message this turn's injection lands on: the latest user message with
 * text content. V2 hands the agent id to the hook directly and runs it only for
 * the agent loop (titles and compactions have hooks of their own).
 *
 * @param {Array<{id?: string, role?: string, content?: any}>} messages
 */
export function findV2InjectionTarget(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user" || !Array.isArray(m.content)) continue;
    if (m.content.some((c) => c?.type === "text" && typeof c.text === "string")) return m;
  }
  return null;
}

/**
 * The bootstrap + context-budget line, built once per turn and replayed
 * byte-identically (see createTurnMemo for why that matters for cost).
 *
 * @param {{agent: string, model?: {providerID?: string, id?: string}, messages: any[]}} event
 *   the `context` hook event (mutated in place)
 * @param {object} opts
 * @param {string} opts.orchestratorAgent
 * @param {() => Promise<string>} opts.getInventory
 * @param {() => Promise<Record<string, number>>} opts.getLimitMap
 * @param {() => boolean} opts.getHasSquad called after getInventory resolves
 * @param {() => Promise<any[]>} opts.getUsageMessages internal `{info}` items for the
 *   session (normalizeUsageMessages of ctx.session.context); request messages
 *   carry no token usage
 * @param {ReturnType<import("../message-transform.js").createTurnMemo>} [opts.turnMemo]
 */
export async function applyOrchestratorTransformV2(event, opts) {
  if (event?.agent !== opts.orchestratorAgent) return;
  const target = findV2InjectionTarget(event.messages);
  if (!target) return;
  if (
    target.content.some(
      (c) => c?.type === "text" && typeof c.text === "string" && c.text.includes(BOOTSTRAP_MARKER),
    )
  ) {
    return;
  }

  const turnId = typeof target.id === "string" ? target.id : null;
  let block = turnId && opts.turnMemo ? opts.turnMemo.get(turnId) : null;
  if (!block) {
    const inventory = await opts.getInventory();
    const nowText = formatLocalDateTime(
      new Date(),
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    const modelText =
      event.model?.providerID && event.model?.id
        ? `${event.model.providerID}/${event.model.id}`
        : null;
    const bootstrap = buildBootstrap(inventory, {
      nowText,
      modelText,
      hasSquad: opts.getHasSquad(),
    });

    let contextLine = null;
    const usage = estimateContextTokens(await opts.getUsageMessages());
    if (usage) {
      const limits = await opts.getLimitMap();
      const limit =
        limits[`${usage.providerID}/${usage.modelID}`] ?? limits[usage.modelID] ?? DEFAULT_LIMIT;
      contextLine = formatContextLine(usage.used, limit);
    }

    block = { bootstrap, contextLine };
    if (turnId && opts.turnMemo) opts.turnMemo.set(turnId, block);
  }

  target.content.unshift({ type: "text", text: block.bootstrap });
  if (block.contextLine) target.content.push({ type: "text", text: block.contextLine });
}
