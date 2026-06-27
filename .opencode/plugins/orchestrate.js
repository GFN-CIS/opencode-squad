/**
 * opencode-squad plugin entry.
 *
 * Responsibilities:
 *   1. Register the bundled grunt (worker) / drill (reviewer) subagents (only
 *      if the user has not already defined an agent with that name).
 *   2. Register the bundled skills directory so squad-delegate is
 *      discoverable.
 *   3. Inject a hidden orchestrator bootstrap (with a live subagent inventory)
 *      into the latest user message every turn, so it survives a context
 *      compaction instead of being lost with the original first message.
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

// Static AA benchmark snapshot (models object), read once. null if missing.
let _benchCache; // undefined = not loaded
function loadBenchmarks() {
  if (_benchCache !== undefined) return _benchCache;
  _benchCache = null;
  try {
    const raw = fs.readFileSync(
      path.join(PACKAGE_ROOT, "src", "benchmarks.json"),
      "utf8",
    );
    _benchCache = JSON.parse(raw).models ?? null;
  } catch {
    // Best-effort; inventory still works without benchmark numbers.
  }
  return _benchCache;
}

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
      _inventoryCache = formatInventory(
        res?.data ?? [],
        loadBenchmarks(),
        await getLimitMap(),
      );
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
      const msgs = output.messages;
      if (!msgs || msgs.length === 0) return;

      // Only the orchestrator (build) session. Gate on whether ANY message is
      // tagged with the orchestrator agent — robust across a compaction, where
      // the leading message becomes a summary (agent="compaction") and a
      // partless synthetic user marker can head the payload. Gating on the
      // first user message's agent (as before) silently dropped the injection
      // after every compaction. Subagent (grunt/drill) sessions carry their own
      // agent, never "build", so they are still skipped.
      if (!msgs.some((m) => m?.info?.agent === ORCHESTRATOR_AGENT)) return;

      // Inject into the LATEST user message that has parts — that's the current
      // turn, always present and re-sent, so the bootstrap survives compaction
      // (which drops/summarizes the original first message). The bootstrap is
      // not persisted, so this re-establishes it every turn.
      const lastUser = [...msgs]
        .reverse()
        .find((m) => m?.info?.role === "user" && m.parts?.length);
      if (!lastUser) return;

      // Never inject into opencode's own internal generations (title / summary /
      // compaction): that payload is a synthetic prompt, and our text would
      // pollute the produced title or summary.
      const leadText =
        lastUser.parts.find(
          (p) => p?.type === "text" && typeof p.text === "string",
        )?.text || "";
      if (
        /^\s*Generate a title for this conversation/.test(leadText) ||
        /^\s*Summarize what was done in this conversation/.test(leadText)
      ) {
        return;
      }

      const refPart = lastUser.parts[0];

      // Bootstrap — ensure it is present this turn (idempotent within the call).
      if (
        !lastUser.parts.some(
          (p) => p?.type === "text" && p.text && p.text.includes(BOOTSTRAP_MARKER),
        )
      ) {
        const inventory = await getInventory();
        const nowText = formatLocalDateTime(
          new Date(),
          Intl.DateTimeFormat().resolvedOptions().timeZone,
        );
        const modelText =
          resolveOrchestratorModel(msgs) ?? _orchestratorModel ?? null;
        const bootstrap = buildBootstrap(inventory, { nowText, modelText });
        lastUser.parts.unshift({ ...refPart, type: "text", text: bootstrap });
      }

      // Live context-budget line on the same latest user message.
      const ctx = estimateContextTokens(msgs);
      if (ctx) {
        const limits = await getLimitMap();
        const limit =
          limits[`${ctx.providerID}/${ctx.modelID}`] ??
          limits[ctx.modelID] ??
          DEFAULT_LIMIT;
        const line = formatContextLine(ctx.used, limit);
        if (line) lastUser.parts.push({ ...refPart, type: "text", text: line });
      }
    },
  };
};

export default { id: "orchestrate", server: OrchestratePlugin };
