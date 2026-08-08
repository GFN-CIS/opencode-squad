/**
 * opencode-squad plugin entry.
 *
 * Responsibilities:
 *   1. Register the bundled skills directory so squad-delegate is
 *      discoverable.
 *   2. Inject a hidden orchestrator bootstrap (with a live subagent inventory)
 *      into the latest user message every turn, so it survives a context
 *      compaction instead of being lost with the original first message. When
 *      no grunt-/drill- agent has been drafted yet, the bootstrap tells the
 *      orchestrator to send the user to squad-draft instead of routing to a
 *      subagent that doesn't exist — there is no bundled fallback agent.
 *   3. Rate-limit guard: opencode's own retry policy retries a rate-limited
 *      subagent FOREVER (honoring the provider's retry-after header up to
 *      ~24.8 days, or a 30s-capped backoff without one) — there is no config
 *      for this in opencode core. For a subagent dispatched via the `task`
 *      tool, that leaves the orchestrator blocked with no signal that it
 *      could just pick a different model. This plugin watches `session.status`
 *      retry events on SUBAGENT sessions and, once a configured threshold is
 *      crossed, aborts the stuck session and — once the orchestrator's turn
 *      goes idle — sends it a plain-language note explaining why and telling
 *      it to reroute to a different grunt/drill. See src/rate-limit-guard.js.
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { formatInventory, hasSquad } from "../../src/inventory.js";
import { formatBench } from "../../src/benchmarks.js";
import {
  readModelData,
  formatPerf,
  buildModelData,
  modelsChanged,
} from "../../src/model-data.js";
import { buildBootstrap, BOOTSTRAP_MARKER } from "../../src/bootstrap.js";
import {
  estimateContextTokens,
  formatContextLine,
  buildLimitMap,
  DEFAULT_LIMIT,
  resolveOrchestratorModel,
  formatLocalDateTime,
} from "../../src/context.js";
import {
  normalizeGuardConfig,
  initGuardState,
  evaluateRetry,
  isGuardedTerminalError,
  formatGuardNote,
} from "../../src/rate-limit-guard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "../..");
const SKILLS_DIR = path.join(PACKAGE_ROOT, "skills");

// The primary agent that acts as the orchestrator. Injection targets only this
// agent's sessions (verified via message.info.agent in the Task 0 spike).
const ORCHESTRATOR_AGENT = "build";

// Cache the subagent inventory string (and whether a squad has been drafted)
// per process — neither changes at runtime. The bootstrap itself is assembled
// per injection so the live facts (current time, current model) stay fresh.
let _inventoryCache; // undefined = not loaded
let _hasSquadCache; // undefined = not loaded

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

// Hand-editable per-squad-model snapshot, keyed by opencode provider/model id.
// Looked for beside the agent dirs opencode merges: the project's .opencode
// first, then the global config dir. null if neither exists (we then fall back
// to the raw AA benchmarks). Read once per process.
let _modelDataCache; // undefined = not loaded
function loadModelData() {
  if (_modelDataCache !== undefined) return _modelDataCache;
  _modelDataCache = null;
  const candidates = [
    path.join(process.cwd(), ".opencode", "model_data.json"),
    path.join(os.homedir(), ".config", "opencode", "model_data.json"),
  ];
  const merged = {};
  let found = false;
  // Global first, then project on top, so project entries win on overlap.
  for (const file of [...candidates].reverse()) {
    const md = readModelData(file);
    if (md) {
      found = true;
      Object.assign(merged, md.models);
    }
  }
  if (found) _modelDataCache = merged;
  return _modelDataCache;
}

// Per-model capability tail for the inventory: model_data entry if we have one
// (precomputed indices + hand-written note), else the raw AA benchmark lookup.
function buildPerfLookup() {
  const modelData = loadModelData();
  const benchmarks = loadBenchmarks();
  return (modelId) => {
    const entry = modelData && modelData[modelId];
    if (entry) return formatPerf(entry);
    return benchmarks ? formatBench(modelId, benchmarks) : null;
  };
}

// Startup auto-regen of the GLOBAL model_data.json: rescan the squad, refresh
// perf from benchmarks, MERGE (preserving hand-written `info`), and write ONLY
// when the models actually changed — so a new grunt/drill or fresh benchmarks
// land automatically without clobbering edits or churning the file every boot.
// Best-effort: any failure is swallowed so it can never break startup. No-op
// when there is no squad yet (0 models). Only the global agent dir is scanned;
// a project's .opencode/model_data.json stays fully manual (via the script's
// --dir). Runs before the inventory cache is built, so the fresh file is read.
function ensureGlobalModelDataFresh() {
  try {
    const benchmarks = loadBenchmarks();
    if (!benchmarks) return;
    const configDir = path.join(os.homedir(), ".config", "opencode");
    const agentDir = path.join(configDir, "agent");
    const file = path.join(configDir, "model_data.json");
    const existing = readModelData(file) || {};
    const generated = new Date().toISOString().slice(0, 10);
    const snapshot = buildModelData(agentDir, benchmarks, existing, generated);
    if (Object.keys(snapshot.models).length === 0) return; // no squad -> nothing
    if (!modelsChanged(existing, snapshot)) return; // unchanged -> no write
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + "\n");
  } catch {
    // Best-effort; the inventory falls back to benchmarks.json regardless.
  }
}

// Configured orchestrator model, captured from config (fallback for turn 1,
// before any assistant message reveals the actual model).
let _orchestratorModel = null;

// Model context-window lookup, resolved once from the provider list.
let _limitMap; // undefined = not loaded

// --- Rate-limit guard state (see src/rate-limit-guard.js for the decision
// logic; everything here is plumbing: caches + the actual SDK calls). ---
let _guardConfig; // normalized once from config.rate_limit_guard
const _guardStates = new Map(); // sessionID -> GuardState (cumulativeMs, guarded)
const _sessionInfoCache = new Map(); // sessionID -> {parentID, agent} | null (null = not a subagent / lookup failed)
const _lastStatusCode = new Map(); // sessionID -> last seen HTTP status code from session.error/message.updated
let _agentsCache; // undefined = not loaded; Map<agentName, {providerID, modelID}>
const _idleWaiters = new Map(); // sessionID -> Array<() => void>, resolved on the next session.status idle for that id

function extractStatusCode(error) {
  if (!error || typeof error !== "object") return undefined;
  const data = /** @type {any} */ (error).data ?? error;
  const value = data?.statusCode ?? data?.status ?? data?.code;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function extractErrorText(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  const data = /** @type {any} */ (error).data ?? error;
  const parts = [error.name, data?.message, error.message].filter(
    (v) => typeof v === "string" && v,
  );
  return parts.join(": ");
}

/** @type {import("@opencode-ai/plugin").Plugin} */
export const OrchestratePlugin = async ({ client, directory }, rawOptions) => {
  // Refresh the global model_data.json once at plugin load (opencode startup),
  // before anything reads it. Cheap and best-effort; see the function comment.
  ensureGlobalModelDataFresh();

  // Rate-limit guard config comes from the plugin-tuple options
  // (["opencode-squad@...", { rate_limit_guard: {...} }]) — NOT a top-level
  // opencode.json field. Confirmed live: opencode.json is strictly schema-
  // validated (Schema.Struct, unrecognized top-level keys are a hard
  // ConfigInvalidError that blocks the ENTIRE config, not just the unknown
  // key) — an earlier version of this guard put the config there and it
  // broke config loading outright. The plugin options slot
  // (ConfigPluginV1.Options = Schema.Record(String, Unknown)) is the
  // officially open, unvalidated escape hatch, and opencode's plugin loader
  // (packages/opencode/src/plugin/index.ts) passes it as this function's
  // second argument regardless of whether the plugin spec is a git URL or an
  // npm name — verified by reading that loader, not assumed.
  _guardConfig = normalizeGuardConfig(
    /** @type {any} */ (rawOptions)?.rate_limit_guard,
  );

  const getInventory = async () => {
    if (_inventoryCache !== undefined) return _inventoryCache;
    _inventoryCache = "(no subagents available)";
    _hasSquadCache = false;
    try {
      const res = await client.app.agents();
      const agents = res?.data ?? [];
      _hasSquadCache = hasSquad(agents);
      _inventoryCache = formatInventory(agents, buildPerfLookup(), await getLimitMap());
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

  // --- Rate-limit guard plumbing ---

  // {parentID, agent} for a session, or null if it has no parent (top-level —
  // never guarded) or the lookup failed. Cached forever: a session's parent
  // and agent never change after creation.
  const getSessionInfo = async (sessionID) => {
    if (_sessionInfoCache.has(sessionID)) return _sessionInfoCache.get(sessionID);
    let info = null;
    try {
      const res = await client.session.get({ sessionID, directory });
      const s = res?.data;
      if (s?.parentID) info = { parentID: s.parentID, agent: s.agent ?? null };
    } catch {
      // Best-effort; treat as "not a subagent" so we never guard by mistake.
    }
    _sessionInfoCache.set(sessionID, info);
    return info;
  };

  const getAgentModel = async (agentName) => {
    if (!agentName) return null;
    if (_agentsCache === undefined) {
      _agentsCache = new Map();
      try {
        const res = await client.app.agents();
        for (const a of res?.data ?? []) {
          if (a?.name && a.model) _agentsCache.set(a.name, a.model);
        }
      } catch {
        // Best-effort; the guard note just says "unknown" model on failure.
      }
    }
    return _agentsCache.get(agentName) ?? null;
  };

  const waitForIdle = (sessionID, timeoutMs = 20_000) =>
    new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        const waiters = _idleWaiters.get(sessionID);
        if (waiters) {
          const idx = waiters.indexOf(finish);
          if (idx !== -1) waiters.splice(idx, 1);
          if (waiters.length === 0) _idleWaiters.delete(sessionID);
        }
        resolve();
      };
      const waiters = _idleWaiters.get(sessionID) ?? [];
      waiters.push(finish);
      _idleWaiters.set(sessionID, waiters);
      setTimeout(finish, timeoutMs);
    });

  // Once the parent (the orchestrator turn that dispatched the guarded
  // subagent) is idle again, send it a plain-language note explaining why
  // and telling it to reroute. Best-effort at every step: a failure here
  // must never take down the session.
  const sendGuardNote = async (parentID, agentName, result) => {
    try {
      await client.tui?.showToast?.({
        directory,
        title: "Rate limit guard",
        message: `Subagent ${agentName ?? "?"} hit a limit (${result.reason}) — told the orchestrator to switch models`,
        variant: "warning",
        duration: 5000,
      });
    } catch {
      // Toast is a nice-to-have.
    }

    const model = await getAgentModel(agentName);
    const note = formatGuardNote({
      model: model ? `${model.providerID}/${model.modelID}` : (agentName ?? "unknown model"),
      provider: model?.providerID ?? "unknown",
      reason: result.reason,
      waitMs: result.waitMs,
      cumulativeMs: result.cumulativeMs,
      errorText: result.errorText,
    });

    await waitForIdle(parentID);
    try {
      await client.session.promptAsync({
        sessionID: parentID,
        directory,
        parts: [{ type: "text", synthetic: true, text: note }],
      });
    } catch {
      // Best-effort — worst case the orchestrator only sees the generic
      // "Task cancelled" tool error (or the bare provider error) and figures
      // it out on its own.
    }
  };

  // Abort a subagent session whose retry wait crossed a threshold, then send
  // the explanatory note.
  const guardAbort = async (sessionID, parentID, agentName, result) => {
    try {
      await client.session.abort({ sessionID, directory });
    } catch {
      // Best-effort; if abort fails the native retry just continues, no worse
      // off than without this guard.
    }
    await sendGuardNote(parentID, agentName, result);
  };

  // Terminal-failure path: the subagent's call already ended (error or
  // cancelled) with NO session.status retry ever seen — e.g. an error whose
  // message opencode's own retryable() doesn't recognize (verified live: a
  // real "token-plan quota has been exhausted" provider error never produces
  // a single retry event, so guardAbort above never runs). Nothing to abort
  // here; just recognize the failure as limit-shaped and explain it.
  const handleTerminalError = async (sessionID, error) => {
    if (!_guardConfig?.enabled) return;
    const state = _guardStates.get(sessionID);
    if (state?.guarded) return; // already handled via the retry path
    const info = await getSessionInfo(sessionID);
    if (!info) return; // not a subagent

    const statusCode = extractStatusCode(error);
    const errorText = extractErrorText(error);
    if (!isGuardedTerminalError(errorText, _guardConfig, statusCode)) return;

    _guardStates.set(sessionID, { ...(state ?? initGuardState()), guarded: true });
    await sendGuardNote(info.parentID, info.agent, { reason: "terminal_error", errorText });
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
    },

    event: async ({ event }) => {
      const props = /** @type {any} */ (event.properties);

      if (event.type === "session.deleted") {
        const id = props?.info?.id;
        if (id) {
          _guardStates.delete(id);
          _sessionInfoCache.delete(id);
          _lastStatusCode.delete(id);
          _idleWaiters.delete(id);
        }
        return;
      }

      if (event.type === "session.status") {
        const sessionID = props?.sessionID;
        const status = props?.status;
        if (!sessionID || !status) return;
        console.error("[GUARD-DEBUG] session.status", status.type, sessionID, status.message ?? "");

        if (status.type === "idle") {
          const waiters = _idleWaiters.get(sessionID);
          if (waiters) for (const finish of [...waiters]) finish();
          return;
        }

        if (status.type !== "retry" || !_guardConfig?.enabled) return;

        const info = await getSessionInfo(sessionID);
        console.error("[GUARD-DEBUG] sessionInfo", sessionID, JSON.stringify(info));
        if (!info) return; // top-level session (or lookup failed) — never guarded

        const state = _guardStates.get(sessionID) ?? initGuardState();
        _guardStates.set(sessionID, state);

        const result = evaluateRetry(
          state,
          status,
          _guardConfig,
          _lastStatusCode.get(sessionID),
          Date.now(),
        );
        console.error("[GUARD-DEBUG] evaluateRetry result", JSON.stringify(result));
        if (result.trigger) {
          state.guarded = true;
          await guardAbort(sessionID, info.parentID, info.agent, result);
        }
        return;
      }

      if (event.type === "session.error") {
        const sessionID = props?.sessionID;
        const code = extractStatusCode(props?.error);
        if (sessionID && code !== undefined) _lastStatusCode.set(sessionID, code);
        if (sessionID && props?.error) await handleTerminalError(sessionID, props.error);
        return;
      }

      if (event.type === "message.updated") {
        const msgInfo = props?.info;
        if (msgInfo?.role === "assistant" && msgInfo?.error && msgInfo?.sessionID) {
          const code = extractStatusCode(msgInfo.error);
          if (code !== undefined) _lastStatusCode.set(msgInfo.sessionID, code);
          await handleTerminalError(msgInfo.sessionID, msgInfo.error);
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
        const bootstrap = buildBootstrap(inventory, {
          nowText,
          modelText,
          hasSquad: _hasSquadCache,
        });
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
