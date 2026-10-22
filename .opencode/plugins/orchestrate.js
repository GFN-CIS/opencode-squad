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
import { tool } from "@opencode-ai/plugin";
import { formatCompactReport, pickCompactionModel, splitModelId } from "../../src/compact.js";
import { buildLimitMap, buildVariantMap, estimateContextTokens } from "../../src/context.js";
import { formatInventory, hasSquad } from "../../src/inventory.js";
import { applyOrchestratorTransform } from "../../src/message-transform.js";
import { applySystemPromptTransform } from "../../src/prompt-inject.js";
import {
  evaluateRetry,
  formatGuardNote,
  initGuardState,
  isGuardedTerminalError,
  isSilentHang,
  normalizeGuardConfig,
} from "../../src/rate-limit-guard.js";
import { validateRoster } from "../../src/roster.js";
import {
  applySquad,
  defaultAgentDir,
  formatApplyReport,
  readSquad,
} from "../../src/squad-apply.js";
import {
  ARG_DESCRIPTIONS,
  formatVariantLines,
  isSubagentCaller,
  TOOL_DESCRIPTIONS,
  validateVariants,
} from "../../src/squad-tools.js";
import { subagentUsage, taskNotes } from "../../src/task-notes.js";
import { isTaskResultEmpty } from "../../src/task-outcome.js";
import {
  buildPerfLookup,
  ensureGlobalModelDataFresh,
  loadModelData,
  loadRolePrompt,
  ORCHESTRATOR_AGENT,
  SKILLS_DIR,
  startBenchmarkRefresh,
  turnMemo,
} from "../lib/runtime.js";

// Cache the subagent inventory string (and whether a squad has been drafted)
// per process — neither changes at runtime. The bootstrap itself is assembled
// per injection so the live facts (current time, current model) stay fresh.
let _inventoryCache; // undefined = not loaded
let _hasSquadCache; // undefined = not loaded

// Configured orchestrator model, captured from config (fallback for turn 1,
// before any assistant message reveals the actual model).
let _orchestratorModel = null;

// Model context-window lookup, resolved once from the provider list.
let _limitMap; // undefined = not loaded

// Model context-window lookup's sibling: provider/model -> accepted variants.
// undefined = not loaded, null = the lookup failed and we must not pretend.
let _variantMap;

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
  startBenchmarkRefresh((toast) =>
    client.tui?.showToast?.({ query: { directory }, body: { ...toast, duration: 10000 } }),
  );

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

  // Which reasoning variants opencode will actually accept, per model — asked
  // of opencode rather than derived from models.dev, because the derivation is
  // a trap (see buildVariantMap). undefined means "could not ask", which is
  // reported as unknown rather than treated as "none".
  const getVariantMap = async () => {
    if (_variantMap !== undefined) return _variantMap;
    try {
      const res = await client.config.providers();
      _variantMap = buildVariantMap(res?.data?.providers ?? []);
    } catch {
      _variantMap = null;
    }
    return _variantMap;
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

  // agent name -> its configured model, loaded once. Also the squad's set of
  // usable models, which is what squad_compact picks the cheapest one out of.
  const getAgentModelMap = async () => {
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
    return _agentsCache;
  };

  const getAgentModel = async (agentName) => {
    if (!agentName) return null;
    await getAgentModelMap();
    return _agentsCache.get(agentName) ?? null;
  };

  // --- Cache-status hint (see src/cache-status.js) ---

  // Facts about a subagent session from one messages fetch (see subagentUsage
  // in src/task-notes.js). Queried fresh rather than tracked in memory: this
  // only needs to be right at the one moment a `task` call just completed.
  const getSubagentUsage = async (sessionID) => {
    try {
      const res = await client.session.messages({ path: { id: sessionID }, query: { directory } });
      return subagentUsage(res?.data ?? []);
    } catch {
      // Best-effort for the cache hint. `usageUnknown` matters more: without it
      // the missing finish reason would read downstream as "finished normally",
      // and an unreadable session would be reported as a subagent that chose to
      // stop — a fabricated cause, which is the one thing [TASK OUTCOME] must
      // never produce.
      return { lastHitMs: null, contextTokens: undefined, usageUnknown: true };
    }
  };

  // Appends [TASK OUTCOME] and [CACHE STATUS] to a completed `task` call's
  // result, so the orchestrator has what it needs to decide whether passing
  // this task_id back in (to reuse the subagent session) still hits a warm
  // provider cache. cache_ttl_seconds is a hand-editable model_data.json field
  // (same pattern as `info`/`billing` — see src/model-data.js); left unset for
  // providers with no published TTL, reported honestly as "unknown" rather
  // than guessed. See src/task-notes.js.
  const handleTaskToolAfter = async (input, output) => {
    if (input?.tool !== "task") return;
    const meta = /** @type {any} */ (output)?.metadata;
    const taskId = meta?.sessionId;
    if (!taskId) return;

    const notes = taskNotes({
      taskId,
      providerID: meta?.model?.providerID,
      modelID: meta?.model?.modelID,
      usage: await getSubagentUsage(taskId),
      resultEmpty: isTaskResultEmpty(/** @type {any} */ (output)?.output),
      modelData: loadModelData(),
      limitMap: await getLimitMap(),
      now: Date.now(),
    });
    for (const note of notes) output.output = `${output.output}\n\n${note}`;
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

  // One agent's settings, shared by both role maps. Every field is optional:
  // `{}` is a perfectly good entry meaning "this model, role defaults".
  const agentEntry = tool.schema.object({
    variant: tool.schema.string().optional().describe(ARG_DESCRIPTIONS["agent.variant"]),
    description: tool.schema.string().optional().describe(ARG_DESCRIPTIONS["agent.description"]),
    notes: tool.schema.string().optional().describe(ARG_DESCRIPTIONS["agent.notes"]),
    steps: tool.schema
      .number()
      .int()
      .positive()
      .optional()
      .describe(ARG_DESCRIPTIONS["agent.steps"]),
    disable: tool.schema.boolean().optional().describe(ARG_DESCRIPTIONS["agent.disable"]),
  });
  const agentMap = tool.schema.record(tool.schema.string(), agentEntry);

  // --- subagent compaction (see src/compact.js) ---

  // How long to wait on the compaction call before reporting back anyway.
  // `POST /session/:id/summarize` runs the compaction inline and only then
  // returns, so on a large history it can outlast a comfortable tool call.
  // Timing out is not a failure: the compaction keeps running server-side,
  // and the report says the sizes may be stale rather than inventing a
  // result.
  const COMPACT_TIMEOUT_MS = 180_000;

  // Context size of a session right now, for the before/after numbers. Same
  // estimator the [CACHE STATUS] size clause uses, so the two agree.
  const readContextTokens = async (sessionID) => {
    try {
      const res = await client.session.messages({
        path: { id: sessionID },
        query: { directory },
      });
      return estimateContextTokens(res?.data ?? [])?.used;
    } catch {
      return undefined;
    }
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

    // --- squad roster tools (see src/squad-apply.js) ---
    //
    // The squad-draft skill used to shell out: `find` the bundled generator
    // somewhere under ~/.cache, then compose a CLI invocation. That is a lot of
    // ceremony for something this plugin is already holding in memory, and the
    // failure mode was silent — a wrong invocation wiped the squad. These two
    // tools give the same operations a typed contract instead: the args schema
    // IS the roster schema, so there is nothing to look up and nothing to
    // assemble by hand.
    tool: {
      squad_compact: tool({
        description: TOOL_DESCRIPTIONS.squad_compact,
        args: {
          task_id: tool.schema.string().describe(ARG_DESCRIPTIONS["compact.task_id"]),
          model: tool.schema.string().optional().describe(ARG_DESCRIPTIONS["compact.model"]),
        },
        async execute(args, ctx) {
          // Rewriting another session's history is strictly more destructive
          // than a roster write, so it takes the same caller guard: a drill is
          // read-only by contract and must not be able to edit a grunt's
          // transcript.
          if (isSubagentCaller(ctx?.agent)) {
            return (
              `Refused: ${ctx.agent} is a subagent, and compacting a session is the ` +
              "orchestrator's call. Say in your result that your context is large; sarge " +
              "decides what to do about it."
            );
          }
          const taskId = String(args.task_id ?? "").trim();
          if (!taskId) return "squad_compact: task_id is required.";

          // Read the session directly rather than through _sessionInfoCache:
          // that cache stores null permanently for a lookup that failed once,
          // which here would silently change which model writes the summary.
          let agentName;
          try {
            const res = await client.session.get({ path: { id: taskId }, query: { directory } });
            agentName = res?.data?.agent ?? undefined;
          } catch {
            // Falls through: the picker does not need the agent, only the
            // report's wording and the last-resort model do.
          }
          const sessionModel = agentName ? await getAgentModel(agentName) : null;
          const modelData = loadModelData() ?? {};
          const available = new Set(
            [...(await getAgentModelMap()).values()].map((m) => `${m.providerID}/${m.modelID}`),
          );
          const picked = pickCompactionModel({
            explicit: args.model,
            models: modelData,
            available,
            sessionModel: sessionModel
              ? `${sessionModel.providerID}/${sessionModel.modelID}`
              : undefined,
          });
          const model = picked && splitModelId(picked.id);
          if (!model) {
            return (
              "squad_compact: could not resolve a model to summarise with. Pass one explicitly " +
              "as `provider/model`."
            );
          }

          const before = await readContextTokens(taskId);
          let timedOut = false;
          try {
            await Promise.race([
              client.session.summarize({
                path: { id: taskId },
                query: { directory },
                body: { providerID: model.providerID, modelID: model.modelID },
              }),
              new Promise((resolve) =>
                setTimeout(() => {
                  timedOut = true;
                  resolve(undefined);
                }, COMPACT_TIMEOUT_MS),
              ),
            ]);
          } catch (e) {
            return `squad_compact: the compaction call failed — ${e?.message ?? String(e)}`;
          }
          // Not read on timeout: the compaction is still running, so the size
          // then is mid-flight and a reduction computed from it would be a
          // stated number that happens to be wrong.
          const after = timedOut ? undefined : await readContextTokens(taskId);

          return formatCompactReport({
            taskId,
            agent: agentName,
            before,
            after,
            model: picked.id,
            why: picked.why,
            timedOut,
          });
        },
      }),

      squad_dump: tool({
        description: TOOL_DESCRIPTIONS.squad_dump,
        args: {
          directory: tool.schema.string().optional().describe(ARG_DESCRIPTIONS["dump.directory"]),
        },
        async execute(args) {
          const dir = args.directory || defaultAgentDir();
          const { roster, conflicts } = readSquad(dir);
          const count =
            Object.keys(roster.grunts ?? {}).length + Object.keys(roster.drills ?? {}).length;
          const note = conflicts.length
            ? `\n\nnotes:\n${conflicts.map((c) => `  ${c}`).join("\n")}`
            : "";
          // The accepted variants come from opencode itself. Without this the
          // caller has to reconstruct them from models.dev `reasoning_options`,
          // which silently under-reports: claude-haiku-4-5 publishes only a
          // budget_tokens option, so an effort-values reading says "none" while
          // opencode in fact accepts high and max.
          const variantLines = formatVariantLines(await getVariantMap(), roster);
          return {
            title: `squad: ${count} agent(s)`,
            output:
              `Agent dir: ${dir}\n${JSON.stringify(roster, null, 2)}${note}${variantLines}\n\n` +
              "To change the squad, pass this same document back to squad_patch with your " +
              "edits applied — keeping every agent you were not asked to touch.",
            metadata: { dir, agents: count },
          };
        },
      }),

      squad_patch: tool({
        description: TOOL_DESCRIPTIONS.squad_patch,
        args: {
          grunts: agentMap.optional().describe(ARG_DESCRIPTIONS["patch.grunts"]),
          drills: agentMap.optional().describe(ARG_DESCRIPTIONS["patch.drills"]),
          allow_remove: tool.schema
            .boolean()
            .optional()
            .describe(ARG_DESCRIPTIONS["patch.allow_remove"]),
          directory: tool.schema.string().optional().describe(ARG_DESCRIPTIONS["patch.directory"]),
        },
        async execute(args, ctx) {
          // A grunt or drill rewriting the squad mid-task is never intended, and
          // the damage outlives the session. Same reasoning as the deletion
          // guard: make the destructive path require the right caller.
          if (isSubagentCaller(ctx?.agent)) {
            return {
              title: "squad_patch refused",
              output:
                `Refused: ${ctx.agent} is a subagent, and the squad roster is the ` +
                "orchestrator's to change. Report what you think should change and let " +
                "sarge decide.",
            };
          }
          const dir = args.directory || defaultAgentDir();
          const roster = { grunts: args.grunts ?? {}, drills: args.drills ?? {} };
          const errors = validateRoster(roster);
          errors.push(...validateVariants(roster, await getVariantMap()));
          if (errors.length) {
            return {
              title: "squad_patch rejected",
              output: `Roster is invalid:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
            };
          }
          const result = applySquad({
            roster,
            dir,
            allowRemove: args.allow_remove === true,
          });
          return {
            title: result.ok
              ? `squad: +${result.diff.added.length} ~${result.diff.changed.length} -${result.diff.removed.length}`
              : "squad_patch refused",
            output: formatApplyReport(result),
            metadata: { ok: result.ok, ...result.diff },
          };
        },
      }),
    },

    "tool.execute.after": handleTaskToolAfter,

    // Refresh a generated agent's role prompt in place. Fires for subagent
    // sessions too (verified live: a dispatched grunt's system[0] arrives here
    // starting with the grunt body), and no-ops on anything without our fence —
    // sarge and hand-authored agents included.
    "experimental.chat.system.transform": async (_input, output) => {
      applySystemPromptTransform(output.system, loadRolePrompt);
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      await applyOrchestratorTransform(output.messages, {
        orchestratorAgent: ORCHESTRATOR_AGENT,
        getInventory,
        getLimitMap,
        getHasSquad: () => _hasSquadCache,
        orchestratorModel: _orchestratorModel,
        turnMemo,
      });
    },
  };
};

export default { id: "orchestrate", server: OrchestratePlugin };
