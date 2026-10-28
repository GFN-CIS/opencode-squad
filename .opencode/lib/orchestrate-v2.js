/**
 * opencode-squad plugin entry for OpenCode 2.
 *
 * Same responsibilities as ../plugins/orchestrate.js (the OpenCode 1 entry);
 * read its header for the why. This file is only the OpenCode 2 wiring:
 *
 *   - skills: registered via ctx.skill.transform (V2 has no config hook);
 *   - bootstrap + context-budget line: the `context` session hook, gated on
 *     the hook's own agent id (src/v2/adapt.js: applyOrchestratorTransformV2);
 *   - role-prompt refresh: the same hook, on the first system part;
 *   - [TASK OUTCOME] / [CACHE STATUS]: `execute.after` on the `subagent` tool;
 *   - squad_compact / squad_dump / squad_patch: ctx.tool.transform with JSON
 *     Schema inputs (src/v2/schemas.js);
 *   - rate-limit guard: the `retry` session hook vetoes the retry outright
 *     (V1 had to abort the session from an event), the event stream covers
 *     terminal errors and silent hangs.
 *
 * Differences from OpenCode 1, by design of the V2 API:
 *   - no toasts: a server plugin has no TUI handle in V2;
 *   - squad_compact cannot choose the summarising model: V2 compaction takes
 *     no model, so the session's compaction settings apply.
 *
 * Must not import `@opencode-ai/plugin` or zod (an OpenCode 2 host provides
 * neither). Never awaits a domain read during setup: reads happen lazily in
 * hooks and tools.
 */

import { formatCompactReport } from "../../src/compact.js";
import { buildLimitMap, buildVariantMap, estimateContextTokens } from "../../src/context.js";
import { formatInventory, hasSquad } from "../../src/inventory.js";
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
  formatVariantLines,
  isSubagentCaller,
  TOOL_DESCRIPTIONS,
  validateVariants,
} from "../../src/squad-tools.js";
import { subagentUsage, taskNotes } from "../../src/task-notes.js";
import { isTaskResultEmpty } from "../../src/task-outcome.js";
import {
  appendToResult,
  applyOrchestratorTransformV2,
  applySystemPartsTransform,
  lastAssistantModel,
  retryToStatus,
  subagentOutcome,
  toV1Agents,
  toV1Providers,
  toV1UsageMessages,
} from "../../src/v2/adapt.js";
import { SQUAD_COMPACT_INPUT, SQUAD_DUMP_INPUT, SQUAD_PATCH_INPUT } from "../../src/v2/schemas.js";
import { loadSkills } from "../../src/v2/skills.js";
import {
  buildPerfLookup,
  ensureGlobalModelDataFresh,
  loadModelData,
  loadRolePrompt,
  ORCHESTRATOR_AGENT,
  SKILLS_DIR,
  startBenchmarkRefresh,
  turnMemo,
} from "./runtime.js";

// How long squad_compact waits for the compaction before reporting anyway.
// Timing out is not a failure: the compaction keeps running server-side.
const COMPACT_TIMEOUT_MS = 180_000;

// How often the silence backstop ticks (see isSilentHang).
const SILENCE_POLL_INTERVAL_MS = 15_000;

/** @param {any} res a V2 response that is either the payload or `{ data }` */
const unwrap = (res) => (res && typeof res === "object" && "data" in res ? res.data : res);

/** @param {any} error V2 SessionStructuredError */
const errorText = (error) =>
  [error?.type, error?.message].filter((v) => typeof v === "string" && v).join(": ");

export default {
  id: "orchestrate",
  async setup(ctx) {
    ensureGlobalModelDataFresh();
    startBenchmarkRefresh();

    // Same option slot as V1: { package: "opencode-squad", options: { rate_limit_guard } }.
    const guardConfig = normalizeGuardConfig(ctx.options?.rate_limit_guard);
    const directory = ctx.location?.directory;

    // --- lazy, process-lifetime lookups (V1 caches the same things) ---

    /** @type {Promise<ReturnType<typeof toV1Agents> | null> | undefined} */
    let agentsPromise;
    const getAgents = () => {
      agentsPromise ??= ctx.agent
        .list()
        .then((r) => toV1Agents(unwrap(r)))
        .catch(() => null);
      return agentsPromise;
    };

    /** @type {Promise<ReturnType<typeof toV1Providers> | null> | undefined} */
    let providersPromise;
    const getProviders = () => {
      providersPromise ??= ctx.model
        .list()
        .then((r) => toV1Providers(unwrap(r)))
        .catch(() => null);
      return providersPromise;
    };
    const getLimitMap = async () => buildLimitMap((await getProviders()) ?? []);
    // null means "could not ask", reported as unknown rather than as "none".
    const getVariantMap = async () => {
      const providers = await getProviders();
      return providers === null ? null : buildVariantMap(providers);
    };

    let inventory;
    let squadDrafted = false;
    const getInventory = async () => {
      if (inventory !== undefined) return inventory;
      const agents = await getAgents();
      squadDrafted = hasSquad(agents ?? []);
      inventory = agents
        ? formatInventory(agents, buildPerfLookup(directory), await getLimitMap())
        : "(no subagents available)";
      return inventory;
    };

    const getAgentModel = async (agentName) => {
      if (!agentName) return null;
      return (await getAgents())?.find((a) => a.name === agentName)?.model ?? null;
    };

    /** @param {string} sessionID */
    const readContext = async (sessionID) => unwrap(await ctx.session.context({ sessionID })) ?? [];

    // --- skills ---

    const skills = loadSkills([SKILLS_DIR]);
    await ctx.skill.transform((editor) => {
      for (const skill of skills) {
        if (!editor.get(skill.id)) editor.add(skill);
      }
    });

    // --- per-request transforms ---

    await ctx.session.hook("context", async (event) => {
      try {
        applySystemPartsTransform(event.system, loadRolePrompt);
      } catch {
        // The agent keeps the body it was generated with.
      }
      try {
        await applyOrchestratorTransformV2(event, {
          orchestratorAgent: ORCHESTRATOR_AGENT,
          getInventory,
          getLimitMap,
          getHasSquad: () => squadDrafted,
          getUsageMessages: async () => toV1UsageMessages(await readContext(event.sessionID)),
          turnMemo,
        });
      } catch {
        // Best-effort, like V1: the turn goes out without the bootstrap.
      }
    });

    // --- subagent result notes ---

    await ctx.tool.hook("execute.after", async (event) => {
      if (event.tool !== "subagent" || event.status !== "completed") return;
      const { sessionID: taskId, output } = subagentOutcome(event.result);
      if (!taskId) return;

      let usage;
      let model = null;
      try {
        const messages = await readContext(taskId);
        usage = subagentUsage(toV1UsageMessages(messages));
        model = lastAssistantModel(messages);
      } catch {
        usage = { lastHitMs: null, contextTokens: undefined, usageUnknown: true };
      }

      const notes = taskNotes({
        taskId,
        providerID: model?.providerID,
        modelID: model?.modelID,
        usage,
        resultEmpty: isTaskResultEmpty(output),
        modelData: loadModelData(directory),
        limitMap: await getLimitMap(),
        now: Date.now(),
      });
      if (notes.length) event.result = appendToResult(event.result, notes.join("\n\n"));
    });

    // --- tools ---

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "squad_compact",
        description: TOOL_DESCRIPTIONS.squad_compact,
        input: SQUAD_COMPACT_INPUT,
        execute: async (input, context) => {
          if (isSubagentCaller(context.agent)) {
            return {
              content:
                `Refused: ${context.agent} is a subagent, and compacting a session is the ` +
                "orchestrator's call. Say in your result that your context is large; sarge " +
                "decides what to do about it.",
            };
          }
          const taskId = String(input?.task_id ?? "").trim();
          if (!taskId) return { content: "squad_compact: task_id is required." };

          let agentName;
          try {
            agentName = unwrap(await ctx.session.get({ sessionID: taskId }))?.agent ?? undefined;
          } catch {
            // Only the report's wording needs the agent.
          }
          const size = async () => {
            try {
              return estimateContextTokens(toV1UsageMessages(await readContext(taskId)))?.used;
            } catch {
              return undefined;
            }
          };
          const before = await size();

          let timedOut = false;
          try {
            await ctx.session.compact({ sessionID: taskId });
            await Promise.race([
              ctx.session.wait({ sessionID: taskId }),
              new Promise((resolve) =>
                setTimeout(() => {
                  timedOut = true;
                  resolve(undefined);
                }, COMPACT_TIMEOUT_MS).unref?.(),
              ),
            ]);
          } catch (e) {
            return {
              content: `squad_compact: the compaction call failed — ${e?.message ?? String(e)}`,
            };
          }
          // The size estimate reads the last completed turn, which a fresh
          // compaction does not have yet: report "could not be read" rather
          // than a number that predates the compaction.
          const after = timedOut
            ? undefined
            : await size().then((n) => (n === before ? undefined : n));

          const ignored = input?.model
            ? ` The requested model ${input.model} was not used: OpenCode 2 compaction takes no model choice.`
            : "";
          return {
            content:
              formatCompactReport({
                taskId,
                agent: agentName,
                before,
                after,
                model: "OpenCode's compaction model",
                why: "OpenCode 2 picks it; squad_compact cannot choose",
                timedOut,
              }) + ignored,
          };
        },
      });

      editor.add({
        name: "squad_dump",
        description: TOOL_DESCRIPTIONS.squad_dump,
        input: SQUAD_DUMP_INPUT,
        execute: async (input) => {
          const dir = input?.directory || defaultAgentDir();
          const { roster, conflicts } = readSquad(dir);
          const count =
            Object.keys(roster.grunts ?? {}).length + Object.keys(roster.drills ?? {}).length;
          const note = conflicts.length
            ? `\n\nnotes:\n${conflicts.map((c) => `  ${c}`).join("\n")}`
            : "";
          const variantLines = formatVariantLines(await getVariantMap(), roster);
          return {
            content:
              `Agent dir: ${dir}\n${JSON.stringify(roster, null, 2)}${note}${variantLines}\n\n` +
              "To change the squad, pass this same document back to squad_patch with your " +
              "edits applied — keeping every agent you were not asked to touch.",
            metadata: { title: `squad: ${count} agent(s)`, dir, agents: count },
          };
        },
      });

      editor.add({
        name: "squad_patch",
        description: TOOL_DESCRIPTIONS.squad_patch,
        input: SQUAD_PATCH_INPUT,
        execute: async (input, context) => {
          if (isSubagentCaller(context.agent)) {
            return {
              content:
                `Refused: ${context.agent} is a subagent, and the squad roster is the ` +
                "orchestrator's to change. Report what you think should change and let " +
                "sarge decide.",
            };
          }
          const dir = input?.directory || defaultAgentDir();
          const roster = { grunts: input?.grunts ?? {}, drills: input?.drills ?? {} };
          const errors = validateRoster(roster);
          errors.push(...validateVariants(roster, await getVariantMap()));
          if (errors.length) {
            return { content: `Roster is invalid:\n${errors.map((e) => `  - ${e}`).join("\n")}` };
          }
          const result = applySquad({
            roster,
            dir,
            allowRemove: input?.allow_remove === true,
            hostGeneration: 2,
          });
          if (result.ok) {
            // The inventory lists the squad; let the next turn see the change.
            inventory = undefined;
            agentsPromise = undefined;
          }
          return {
            content: formatApplyReport(result),
            metadata: { ok: result.ok, ...result.diff },
          };
        },
      });
    });

    // --- rate-limit guard ---

    const guardStates = new Map(); // sessionID -> GuardState
    const sessionInfo = new Map(); // sessionID -> {parentID, agent} | null
    const lastActivity = new Map(); // sessionID -> epoch ms
    const pollTimers = new Map(); // sessionID -> interval handle

    const getSessionInfo = async (sessionID) => {
      if (sessionInfo.has(sessionID)) return sessionInfo.get(sessionID);
      let info = null;
      try {
        const s = unwrap(await ctx.session.get({ sessionID }));
        if (s?.parentID) info = { parentID: s.parentID, agent: s.agent ?? null };
      } catch {
        // Treat as "not a subagent" so we never guard by mistake.
      }
      sessionInfo.set(sessionID, info);
      return info;
    };

    const stopSilenceWatch = (sessionID) => {
      const timer = pollTimers.get(sessionID);
      if (timer) clearInterval(timer);
      pollTimers.delete(sessionID);
    };

    // Explain to the orchestrator why its subagent failed and that it should
    // reroute. Steered into the parent's running turn, so it lands right after
    // the failed subagent call; `resume` starts a turn if the parent is idle.
    const sendGuardNote = async (parentID, agentName, result) => {
      const model = await getAgentModel(agentName);
      const text = formatGuardNote({
        model: model ? `${model.providerID}/${model.modelID}` : (agentName ?? "unknown model"),
        provider: model?.providerID ?? "unknown",
        reason: result.reason,
        waitMs: result.waitMs,
        cumulativeMs: result.cumulativeMs,
        until: result.until,
        silentMs: result.silentMs,
        errorText: result.errorText,
      });
      try {
        await ctx.session.synthetic({
          sessionID: parentID,
          text,
          description: "squad rate-limit guard",
          delivery: "steer",
          resume: true,
        });
      } catch {
        // Worst case the orchestrator sees only the subagent's own failure.
      }
    };

    if (guardConfig.enabled) {
      await ctx.session.hook("retry", async (event) => {
        if (!event.decision?.retry) return;
        const info = await getSessionInfo(event.sessionID);
        if (!info) return; // top-level session — never guarded
        const state = guardStates.get(event.sessionID) ?? initGuardState();
        guardStates.set(event.sessionID, state);
        const now = Date.now();
        const result = evaluateRetry(
          state,
          retryToStatus(event, now),
          guardConfig,
          event.error?.status,
          now,
        );
        if (!result.trigger) return;
        state.guarded = true;
        event.decision = { retry: false };
        stopSilenceWatch(event.sessionID);
        void sendGuardNote(info.parentID, info.agent, result);
      });
    }

    const startSilenceWatch = (sessionID) => {
      if (pollTimers.has(sessionID) || !guardConfig.enabled) return;
      const timer = setInterval(async () => {
        const state = guardStates.get(sessionID);
        if (state?.guarded) return stopSilenceWatch(sessionID);
        const last = lastActivity.get(sessionID);
        if (last === undefined || !isSilentHang(last, guardConfig, Date.now())) return;
        const info = await getSessionInfo(sessionID);
        if (!info) return stopSilenceWatch(sessionID);
        guardStates.set(sessionID, { ...(state ?? initGuardState()), guarded: true });
        stopSilenceWatch(sessionID);
        try {
          await ctx.session.interrupt({ sessionID, continue: false });
        } catch {
          // No worse off than without the guard.
        }
        await sendGuardNote(info.parentID, info.agent, {
          reason: "silent_hang",
          silentMs: Date.now() - last,
        });
      }, SILENCE_POLL_INTERVAL_MS);
      timer.unref?.();
      pollTimers.set(sessionID, timer);
    };

    const handleTerminalError = async (sessionID, error) => {
      if (!guardConfig.enabled) return;
      const state = guardStates.get(sessionID);
      if (state?.guarded) return; // already handled by the retry hook
      const info = await getSessionInfo(sessionID);
      if (!info) return;
      const text = errorText(error);
      if (!isGuardedTerminalError(text, guardConfig, error?.status)) return;
      guardStates.set(sessionID, { ...(state ?? initGuardState()), guarded: true });
      await sendGuardNote(info.parentID, info.agent, { reason: "terminal_error", errorText: text });
    };

    const forget = (sessionID) => {
      guardStates.delete(sessionID);
      sessionInfo.delete(sessionID);
      lastActivity.delete(sessionID);
      stopSilenceWatch(sessionID);
    };

    const events = new AbortController();
    if (guardConfig.enabled) {
      void (async () => {
        for await (const event of ctx.event.subscribe({ signal: events.signal })) {
          const data = event?.data;
          const sessionID = data?.sessionID;
          if (typeof sessionID !== "string") continue;
          // Any event naming a watched session is proof of life.
          if (pollTimers.has(sessionID)) lastActivity.set(sessionID, Date.now());
          switch (event.type) {
            case "session.created":
              if (data.parentID) {
                sessionInfo.set(sessionID, { parentID: data.parentID, agent: data.agent ?? null });
                lastActivity.set(sessionID, Date.now());
                startSilenceWatch(sessionID);
              }
              break;
            case "session.deleted":
              forget(sessionID);
              break;
            case "session.execution.succeeded":
            case "session.execution.interrupted":
              stopSilenceWatch(sessionID);
              break;
            case "session.execution.failed":
              stopSilenceWatch(sessionID);
              void handleTerminalError(sessionID, data.error);
              break;
          }
        }
      })().catch(() => {
        // Stream closed on unload.
      });
    }

    return () => {
      events.abort();
      for (const id of [...pollTimers.keys()]) stopSilenceWatch(id);
    };
  },
};
