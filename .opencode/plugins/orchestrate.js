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
 *
 * The bootstrap/context-budget injection logic itself lives in
 * src/message-transform.js (pure + directly unit-tested); this file wires it
 * to the actual client calls. Likewise the `event` hook below is a thin
 * switch dispatching to one small handler per event.type — see
 * docs/artifacts/code-health-report-20260808.md for why.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatBench } from "../../src/benchmarks.js";
import { formatCacheStatus } from "../../src/cache-status.js";
import { buildLimitMap } from "../../src/context.js";
import { formatInventory, hasSquad } from "../../src/inventory.js";
import { applyOrchestratorTransform } from "../../src/message-transform.js";
import { buildModelData, formatPerf, modelsChanged, readModelData } from "../../src/model-data.js";
import {
  evaluateRetry,
  formatGuardNote,
  initGuardState,
  isGuardedTerminalError,
  isSilentHang,
  normalizeGuardConfig,
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
    const raw = fs.readFileSync(path.join(PACKAGE_ROOT, "src", "benchmarks.json"), "utf8");
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
    const entry = modelData?.[modelId];
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
    fs.writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
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

// Polling backstop (see isSilentHang in src/rate-limit-guard.js): catches a
// guarded subagent that never produces a single event of any kind, which
// neither the retry path nor the terminal-error path can see since both are
// purely event-driven.
const _lastActivityTime = new Map(); // sessionID -> epoch ms of the last message/part event seen for it
const _pollTimers = new Map(); // sessionID -> setInterval handle, one per subagent session being watched
// How often the silence backstop ticks. Plumbing, not a decision (that's
// max_silence_seconds, in rate-limit-guard.js's config) — nobody has asked to
// tune this, so it's a constant rather than a config knob (YAGNI).
const SILENCE_POLL_INTERVAL_MS = 15_000;

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
  _guardConfig = normalizeGuardConfig(/** @type {any} */ (rawOptions)?.rate_limit_guard);

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
      const res = await client.session.get({ path: { id: sessionID }, query: { directory } });
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

  // --- Cache-status hint (see src/cache-status.js) ---

  // The epoch ms of the last actual provider hit for a session: the most
  // recent assistant message's request-start time. Queried fresh each time
  // rather than tracked in memory — this only needs to be right at the one
  // moment a `task` call just completed, not continuously.
  const getLastProviderHit = async (sessionID) => {
    try {
      const res = await client.session.messages({ path: { id: sessionID }, query: { directory } });
      const msgs = res?.data ?? [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const created = msgs[i]?.info?.time?.created;
        if (msgs[i]?.info?.role === "assistant" && typeof created === "number") return created;
      }
    } catch {
      // Best-effort; no hint is appended if we can't tell.
    }
    return null;
  };

  // Appends a [CACHE STATUS] line to a completed `task` call's result, so the
  // orchestrator has what it needs to decide whether passing this task_id
  // back in (to reuse the subagent session) still hits a warm provider
  // cache, or whether the cache has gone cold and a fresh session is no
  // worse. cache_ttl_seconds is a hand-editable model_data.json field (same
  // pattern as `info`/`billing` — see src/model-data.js); left unset for
  // providers with no published TTL, reported honestly as "unknown" rather
  // than guessed.
  const handleTaskToolAfter = async (input, output) => {
    if (input?.tool !== "task") return;
    const meta = /** @type {any} */ (output)?.metadata;
    const taskId = meta?.sessionId;
    const providerID = meta?.model?.providerID;
    const modelID = meta?.model?.modelID;
    if (!taskId || !providerID || !modelID) return;

    const lastHitMs = await getLastProviderHit(taskId);
    if (lastHitMs === null) return;

    const modelData = loadModelData();
    const ttlSeconds = modelData?.[`${providerID}/${modelID}`]?.cache_ttl_seconds;

    const note = formatCacheStatus({
      taskId,
      providerModelId: `${providerID}/${modelID}`,
      lastHitMs,
      ttlSeconds: typeof ttlSeconds === "number" ? ttlSeconds : undefined,
      now: Date.now(),
    });
    output.output = `${output.output}\n\n${note}`;
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
        query: { directory },
        body: {
          title: "Rate limit guard",
          message: `Subagent ${agentName ?? "?"} hit a limit (${result.reason}) — told the orchestrator to switch models`,
          variant: "warning",
          duration: 5000,
        },
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
      until: result.until,
      errorText: result.errorText,
    });

    await waitForIdle(parentID);
    try {
      await client.session.promptAsync({
        path: { id: parentID },
        query: { directory },
        body: { parts: [{ type: "text", synthetic: true, text: note }] },
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
      await client.session.abort({ path: { id: sessionID }, query: { directory } });
    } catch {
      // Best-effort; if abort fails the native retry just continues, no worse
      // off than without this guard.
    }
    stopSilenceWatch(sessionID);
    await sendGuardNote(parentID, agentName, result);
  };

  // --- Silence-polling backstop (isSilentHang) ---

  const stopSilenceWatch = (sessionID) => {
    const timer = _pollTimers.get(sessionID);
    if (timer) {
      clearInterval(timer);
      _pollTimers.delete(sessionID);
    }
  };

  // One setInterval per subagent session, started when it's created. Ticks
  // independently of any opencode event — this is the whole point: it's the
  // only path that still catches a session that never emits a single event.
  const startSilenceWatch = (sessionID) => {
    if (_pollTimers.has(sessionID) || !_guardConfig?.enabled) return;
    const timer = setInterval(async () => {
      if (!_guardConfig?.enabled) return stopSilenceWatch(sessionID);
      const state = _guardStates.get(sessionID);
      if (state?.guarded) return stopSilenceWatch(sessionID); // handled via another path already

      const last = _lastActivityTime.get(sessionID);
      if (last === undefined || !isSilentHang(last, _guardConfig, Date.now())) return;

      const info = await getSessionInfo(sessionID);
      if (!info) return stopSilenceWatch(sessionID); // not a subagent (or lookup failed) — never guard it

      _guardStates.set(sessionID, { ...(state ?? initGuardState()), guarded: true });
      await guardAbort(sessionID, info.parentID, info.agent, {
        reason: "silent_hang",
        silentMs: Date.now() - last,
      });
    }, SILENCE_POLL_INTERVAL_MS);
    _pollTimers.set(sessionID, timer);
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

  // --- Event dispatch: one small function per event.type, so no single
  // function carries the combined branching of all four (previously a single
  // 25-CC handler — see docs/artifacts/code-health-report-20260808.md). ---

  const handleSessionDeleted = (props) => {
    const id = props?.info?.id;
    if (!id) return;
    _guardStates.delete(id);
    _sessionInfoCache.delete(id);
    _lastStatusCode.delete(id);
    _idleWaiters.delete(id);
    _lastActivityTime.delete(id);
    stopSilenceWatch(id);
  };

  // A new subagent session just got created — start the silence-polling
  // backstop for it. Top-level sessions (no parentID) are never watched.
  const handleSessionCreated = (props) => {
    const info = props?.info;
    const id = info?.id;
    if (!id || !info?.parentID) return;
    if (!_sessionInfoCache.has(id)) {
      _sessionInfoCache.set(id, { parentID: info.parentID, agent: info.agent ?? null });
    }
    _lastActivityTime.set(id, Date.now());
    startSilenceWatch(id);
  };

  const handleSessionStatus = async (props) => {
    const sessionID = props?.sessionID;
    const status = props?.status;
    if (!sessionID || !status) return;

    if (status.type === "idle") {
      stopSilenceWatch(sessionID); // finished cleanly — no need to keep polling it
      const waiters = _idleWaiters.get(sessionID);
      if (waiters) for (const finish of [...waiters]) finish();
      return;
    }

    if (status.type !== "retry" || !_guardConfig?.enabled) return;

    const info = await getSessionInfo(sessionID);
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
    if (result.trigger) {
      state.guarded = true;
      await guardAbort(sessionID, info.parentID, info.agent, result);
    }
  };

  const handleSessionErrorEvent = async (props) => {
    const sessionID = props?.sessionID;
    const code = extractStatusCode(props?.error);
    if (sessionID && code !== undefined) _lastStatusCode.set(sessionID, code);
    if (sessionID && props?.error) await handleTerminalError(sessionID, props.error);
  };

  const handleMessageUpdatedEvent = async (props) => {
    const msgInfo = props?.info;
    if (msgInfo?.role !== "assistant" || !msgInfo?.error || !msgInfo?.sessionID) return;
    const code = extractStatusCode(msgInfo.error);
    if (code !== undefined) _lastStatusCode.set(msgInfo.sessionID, code);
    await handleTerminalError(msgInfo.sessionID, msgInfo.error);
  };

  return {
    config: async (config) => {
      // Capture the orchestrator's configured model as a turn-1 fallback
      // (build's own model, else the global default).
      _orchestratorModel = config.agent?.[ORCHESTRATOR_AGENT]?.model ?? config.model ?? null;

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

      // Activity touch for the silence-polling backstop: ANY event that
      // references a session counts as proof-of-life for it, regardless of
      // event.type — this is deliberately broad (message/part updates,
      // status changes, errors all count) so a genuinely busy subagent never
      // gets false-positived just because we didn't special-case its event.
      const activeSessionID =
        props?.sessionID ?? props?.info?.sessionID ?? props?.info?.id ?? props?.part?.sessionID;
      if (activeSessionID && _pollTimers.has(activeSessionID)) {
        _lastActivityTime.set(activeSessionID, Date.now());
      }

      switch (event.type) {
        case "session.created":
          return handleSessionCreated(props);
        case "session.deleted":
          return handleSessionDeleted(props);
        case "session.status":
          return handleSessionStatus(props);
        case "session.error":
          return handleSessionErrorEvent(props);
        case "message.updated":
          return handleMessageUpdatedEvent(props);
      }
    },

    "tool.execute.after": handleTaskToolAfter,

    "experimental.chat.messages.transform": async (_input, output) => {
      await applyOrchestratorTransform(output.messages, {
        orchestratorAgent: ORCHESTRATOR_AGENT,
        getInventory,
        getLimitMap,
        getHasSquad: () => _hasSquadCache,
        orchestratorModel: _orchestratorModel,
      });
    },
  };
};

export default { id: "orchestrate", server: OrchestratePlugin };
