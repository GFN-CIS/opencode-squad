/**
 * opencode-squad plugin entry.
 *
 * Responsibilities:
 *   1. Register the bundled grunt (worker) / drill (reviewer) subagents (only
 *      if the user has not already defined an agent with that name).
 *   2. Register the bundled skills directory so sarge-delegate is
 *      discoverable.
 *   3. Inject a hidden orchestrator bootstrap (with a live subagent inventory)
 *      into the first user message of a session.
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { agentDefinitions } from "../../src/agents.js";
import { formatInventory } from "../../src/inventory.js";
import { buildBootstrap, BOOTSTRAP_MARKER } from "../../src/bootstrap.js";
import {
  estimateContextTokens,
  formatContextLine,
  buildLimitMap,
  DEFAULT_LIMIT,
  resolveOrchestratorModel,
  formatLocalDateTime,
} from "../../src/context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "../..");
const PROMPTS_DIR = path.join(PACKAGE_ROOT, "prompts");
const SKILLS_DIR = path.join(PACKAGE_ROOT, "skills");

// The primary agent that acts as the orchestrator. Injection targets only this
// agent's sessions (verified via message.info.agent in the Task 0 spike).
const ORCHESTRATOR_AGENT = "build";

// Cache the subagent inventory string per process (it does not change at
// runtime). The bootstrap itself is assembled per injection so the live facts
// (current time, current model) stay fresh.
let _inventoryCache; // undefined = not loaded

// Configured orchestrator model, captured from config (fallback for turn 1,
// before any assistant message reveals the actual model).
let _orchestratorModel = null;

// Model context-window lookup, resolved once from the provider list.
let _limitMap; // undefined = not loaded

/** @type {import("@opencode-ai/plugin").Plugin} */
export const OrchestratePlugin = async ({ client }) => {
  const getInventory = async () => {
    if (_inventoryCache !== undefined) return _inventoryCache;
    _inventoryCache = "(no subagents available)";
    try {
      const res = await client.app.agents();
      _inventoryCache = formatInventory(res?.data ?? []);
    } catch {
      // Inventory is best-effort; the bootstrap still works without it.
    }
    return _inventoryCache;
  };

  const getLimitMap = async () => {
    if (_limitMap !== undefined) return _limitMap;
    _limitMap = {};
    try {
      const res = await client.config.providers();
      _limitMap = buildLimitMap(res?.data?.providers ?? []);
    } catch {
      // Best-effort; falls back to DEFAULT_LIMIT per model.
    }
    return _limitMap;
  };

  return {
    config: async (config) => {
      // Capture the orchestrator's configured model as a turn-1 fallback
      // (build's own model, else the global default).
      _orchestratorModel =
        config.agent?.[ORCHESTRATOR_AGENT]?.model ?? config.model ?? null;

      // Register bundled skills directory (runtime field, untyped).
      if (fs.existsSync(SKILLS_DIR)) {
        const cfg = /** @type {any} */ (config);
        cfg.skills = cfg.skills || {};
        cfg.skills.paths = cfg.skills.paths || [];
        if (!cfg.skills.paths.includes(SKILLS_DIR)) {
          cfg.skills.paths.push(SKILLS_DIR);
        }
      }

      // Define bundled subagents only if the user has not defined them.
      config.agent = config.agent || {};
      const defs = agentDefinitions(PROMPTS_DIR);
      for (const [name, def] of Object.entries(defs)) {
        if (!config.agent[name]) {
          config.agent[name] = def;
        }
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      if (!output.messages || output.messages.length === 0) return;
      const firstUser = output.messages.find((m) => m?.info?.role === "user");
      if (!firstUser || !firstUser.parts || firstUser.parts.length === 0) return;

      // Only inject for the orchestrator (primary build agent). The hook's
      // `input` is empty, but each message carries `info.agent` (verified in
      // the Task 0 spike: "build" for the primary session, the subagent name
      // for grunt/drill subagent sessions). This skips subagent sessions.
      if (firstUser.info?.agent !== ORCHESTRATOR_AGENT) return;

      // Guard against double injection.
      if (
        firstUser.parts.some(
          (p) => p?.type === "text" && p.text && p.text.includes(BOOTSTRAP_MARKER),
        )
      ) {
        return;
      }

      // Assemble per injection so the live facts stay fresh (datetime must not
      // be cached across the long-lived process; model may change per session).
      const inventory = await getInventory();
      const nowText = formatLocalDateTime(
        new Date(),
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      );
      const modelText =
        resolveOrchestratorModel(output.messages) ?? _orchestratorModel ?? null;
      const bootstrap = buildBootstrap(inventory, { nowText, modelText });
      const ref = firstUser.parts[0];
      firstUser.parts.unshift({ ...ref, type: "text", text: bootstrap });

      // Append a live context-budget line to the LATEST user message so the
      // orchestrator can weigh its current context size in the verdict. Not
      // persisted (like the bootstrap), so it never accumulates across turns;
      // null before the first assistant reply (context is still small).
      const ctx = estimateContextTokens(output.messages);
      let line = null;
      if (ctx) {
        const limits = await getLimitMap();
        const limit =
          limits[`${ctx.providerID}/${ctx.modelID}`] ??
          limits[ctx.modelID] ??
          DEFAULT_LIMIT;
        line = formatContextLine(ctx.used, limit);
      }
      if (line) {
        const lastUser = [...output.messages]
          .reverse()
          .find((m) => m?.info?.role === "user" && m.parts?.length);
        if (lastUser) {
          const lref = lastUser.parts[0];
          lastUser.parts.push({ ...lref, type: "text", text: line });
        }
      }
    },
  };
};

export default { id: "orchestrate", server: OrchestratePlugin };
