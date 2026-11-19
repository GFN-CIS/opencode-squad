/**
 * opencode-squad plugin entry for OpenCode 2.
 *
 * Host wiring over pure decision modules in src/:
 *
 *   - skills: registered via ctx.skill.transform (V2 has no config hook);
 *   - bootstrap: appended to the orchestrator's system prompt by the `context`
 *     session hook, gated on the hook's own agent id (src/v2/adapt.js:
 *     applyOrchestratorTransformV2). Messages are never modified;
 *   - role-prompt refresh: the same hook, on the first system part;
 *   - squad_session / squad_compact / squad_dump / squad_patch / squad_metrics:
 *     ctx.tool.transform with JSON
 *     Schema inputs (src/v2/schemas.js);
 *   - provider quota: the `http.response` session hook reads rate-limit
 *     headers off a subagent's model responses and steers a [QUOTA] note
 *     into its orchestrator on a band change (src/quota.js);
 *   - rate-limit guard: the `retry` session hook vetoes the retry outright
 *     while the event stream covers
 *     terminal errors and silent hangs.
 *
 * Host API constraints:
 *   - no toasts: a server plugin has no TUI handle in V2;
 *   - squad_compact cannot choose the summarising model: V2 compaction takes
 *     no model, so the session's compaction settings apply.
 *
 * Never awaits a domain read during setup: reads happen lazily in
 * hooks and tools.
 */

import { formatCompactReport } from "../../src/compact.js";
import { estimateContextTokens, indexModelCatalog } from "../../src/context.js";
import { formatInventory, hasSquad } from "../../src/inventory.js";
import {
  formatDetail,
  formatSummary,
  lookup,
  squadRoles,
  superindexOf,
} from "../../src/metrics.js";
import { fetchDetail } from "../../src/metrics-cache.js";
import { createQuotaReporter } from "../../src/quota.js";
import {
  evaluateRetry,
  formatGuardNote,
  initGuardState,
  isGuardedTerminalError,
  isSilentHang,
  normalizeGuardConfig,
} from "../../src/rate-limit-guard.js";
import { validatePatchInput } from "../../src/roster-schema.js";
import {
  formatNow,
  formatOwnStatus,
  formatSessionStatus,
  requestedSessions,
  sessionFacts,
} from "../../src/session-status.js";
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
import {
  applyOrchestratorTransformV2,
  applySystemPartsTransform,
  normalizeAgents,
  normalizeUsageMessages,
  retryToStatus,
} from "../../src/v2/adapt.js";
import {
  SQUAD_COMPACT_INPUT,
  SQUAD_DUMP_INPUT,
  SQUAD_METRICS_INPUT,
  SQUAD_PATCH_INPUT,
  SQUAD_SESSION_INPUT,
} from "../../src/v2/schemas.js";
import { loadSkills } from "../../src/v2/skills.js";
import {
  describerScope,
  ensureGlobalModelDataFresh,
  getMetrics,
  loadAuthTypes,
  loadModelSettings,
  loadRolePrompt,
  METRICS_DIR,
  ORCHESTRATOR_AGENT,
  SKILLS_DIR,
  squadDescriber,
  startMetricsRefresh,
  syncGlobalSquadDescriptions,
} from "./runtime.js";

// squad_metrics({full: true}) returns ~2K tokens per model; cap the bill.
const MAX_FULL_MODELS = 6;

// How long the agent list (and the inventory rendered from it) is reused.
const AGENTS_TTL_MS = 15_000;

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

/** @typedef {import("@opencode/plugin").Plugin.Context} PluginContext */
/** @typedef {import("@opencode/plugin").Skill.Info} SkillInfo */
/** @typedef {import("../../src/roster-schema.js").SquadPatchInput} SquadPatchInput */

/** @type {import("@opencode/plugin").Plugin.Plugin} */
export default {
  id: "squad",
  /** @param {PluginContext} ctx */
  async setup(ctx) {
    ensureGlobalModelDataFresh();
    // After the regen, which may rewrite model_data.json. opencode reloads
    // the rewritten agent files on its own (agent.updated).
    syncGlobalSquadDescriptions();
    startMetricsRefresh();

    // { package: "opencode-squad", options: { rate_limit_guard } }.
    const guardConfig = normalizeGuardConfig(ctx.options?.rate_limit_guard);
    const directory = ctx.location?.directory;

    // --- lazy, process-lifetime lookups ---

    // opencode reloads agent files live, so the list is re-read after a short
    // TTL rather than held for the process lifetime: the startup description
    // sync and squad_patch both land seconds AFTER a first turn may have
    // asked, and the desktop service runs for hours.
    /** @type {Promise<ReturnType<typeof normalizeAgents> | null> | undefined} */
    let agentsPromise;
    let agentsAt = 0;
    const getAgents = () => {
      if (!agentsPromise || Date.now() - agentsAt > AGENTS_TTL_MS) {
        agentsAt = Date.now();
        agentsPromise = ctx.agent
          .list()
          .then((r) => normalizeAgents(unwrap(r)))
          .catch(() => null);
      }
      return agentsPromise;
    };

    // The model catalog barely changes while the process lives, so a
    // successful lookup is kept. Concurrent callers share one in-flight
    // request; a FAILED one is dropped, so the next tool call asks again
    // instead of running without variant checks until a restart.
    /** @type {Promise<ReturnType<typeof indexModelCatalog> | null> | undefined} */
    let catalogPromise;
    const getCatalog = () => {
      if (!catalogPromise) {
        /** @type {Promise<ReturnType<typeof indexModelCatalog> | null>} */
        const pending = Promise.resolve()
          .then(() => ctx.model.list())
          .then((r) => indexModelCatalog(unwrap(r)))
          .catch(() => {
            if (catalogPromise === pending) catalogPromise = undefined;
            return null;
          });
        catalogPromise = pending;
      }
      return catalogPromise;
    };
    const getLimitMap = async () => (await getCatalog())?.limits ?? {};
    // null means "could not ask", reported as unknown rather than as "none".
    const getVariantMap = async () => (await getCatalog())?.variants ?? null;

    /** @type {string | undefined} */
    let inventory;
    /** @type {Awaited<ReturnType<typeof getAgents>> | undefined} */
    let inventoryFrom; // the agents list `inventory` was rendered from
    let squadDrafted = false;
    const getInventory = async () => {
      const agents = await getAgents();
      if (inventory !== undefined && inventoryFrom === agents) return inventory;
      inventoryFrom = agents;
      squadDrafted = hasSquad(agents ?? []);
      inventory = agents
        ? formatInventory(agents, await getLimitMap())
        : "(no subagents available)";
      return inventory;
    };

    /** @param {string | null | undefined} agentName */
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
        // The host brands its ids and paths; ours come from SKILL.md files on
        // disk in exactly the shape OpenCode builds for a discovered skill.
        if (!editor.get(skill.id))
          editor.add(/** @type {SkillInfo} */ (/** @type {unknown} */ (skill)));
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
          getHasSquad: () => squadDrafted,
        });
      } catch {
        // Best-effort: the turn goes out without the bootstrap.
      }
    });

    // --- tools ---

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "squad_session",
        description: TOOL_DESCRIPTIONS.squad_session,
        input: SQUAD_SESSION_INPUT,
        execute: async (input, context) => {
          const now = Date.now();
          const limits = await getLimitMap();
          /** @param {string | null | undefined} model */
          const limitOf = (model) =>
            model ? (limits[model] ?? limits[model.split("/").slice(1).join("/")]) : undefined;
          const ids = requestedSessions(input);
          if (!ids.length) {
            const own = context?.sessionID;
            let facts = null;
            try {
              if (own) facts = sessionFacts(await readContext(own));
            } catch {
              // The clock alone is still worth returning.
            }
            return {
              content: formatOwnStatus({
                contextTokens: facts?.contextTokens,
                contextLimit: limitOf(facts?.model),
                now,
              }),
            };
          }
          const modelData = loadModelSettings(directory).models;
          const reports = await Promise.all(
            ids.map(async (sessionID) => {
              let facts;
              try {
                facts = sessionFacts(await readContext(sessionID));
              } catch (e) {
                const err =
                  /** @type {{message?: string, _tag?: string, name?: string} | undefined} */ (e);
                const why =
                  err?.message || err?._tag || err?.name || JSON.stringify(e) || "unknown error";
                return `session ${sessionID}: could not be read (${why}). Treat it as cold.`;
              }
              const ttl = facts.model ? modelData[facts.model]?.cache_ttl_seconds : undefined;
              return formatSessionStatus({
                sessionID,
                facts,
                ttlSeconds: typeof ttl === "number" ? ttl : undefined,
                contextLimit: limitOf(facts.model),
                now,
              });
            }),
          );
          return {
            content: [formatNow(now), ...reports].join("\n\n"),
            metadata: { title: `sessions: ${ids.length}` },
          };
        },
      });

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
          const taskId = String(
            /** @type {{sessionID?: unknown}} */ (input)?.sessionID ?? "",
          ).trim();
          if (!taskId) return { content: "squad_compact: sessionID is required." };

          let agentName;
          try {
            agentName = unwrap(await ctx.session.get({ sessionID: taskId }))?.agent ?? undefined;
          } catch {
            // Only the report's wording needs the agent.
          }
          const size = async () => {
            try {
              return estimateContextTokens(normalizeUsageMessages(await readContext(taskId)))?.used;
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
              content: `squad_compact: the compaction call failed — ${e instanceof Error ? e.message : String(e)}`,
            };
          }
          // The size estimate reads the last completed turn, which a fresh
          // compaction does not have yet: report "could not be read" rather
          // than a number that predates the compaction.
          const after = timedOut
            ? undefined
            : await size().then((n) => (n === before ? undefined : n));

          return {
            content: formatCompactReport({
              taskId,
              agent: agentName,
              before,
              after,
              model: "OpenCode's compaction model",
              why: "OpenCode 2's compaction settings pick it; squad_compact cannot choose",
              timedOut,
            }),
          };
        },
      });

      editor.add({
        name: "squad_dump",
        description: TOOL_DESCRIPTIONS.squad_dump,
        input: SQUAD_DUMP_INPUT,
        execute: async (input) => {
          const { directory: asked } = /** @type {{directory?: unknown}} */ (input ?? {});
          const dir = typeof asked === "string" && asked ? asked : defaultAgentDir();
          const { roster, conflicts: readConflicts } = readSquad(dir);
          const conflicts = readConflicts;
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
        name: "squad_metrics",
        description: TOOL_DESCRIPTIONS.squad_metrics,
        input: SQUAD_METRICS_INPUT,
        execute: async (input) => {
          const { models: asked, full } = /** @type {{models?: unknown, full?: unknown}} */ (
            input ?? {}
          );
          const wanted = [
            ...new Set(
              (Array.isArray(asked) ? asked : [])
                .map((/** @type {unknown} */ m) => String(m).trim())
                .filter(Boolean),
            ),
          ];
          if (!wanted.length) {
            return {
              content:
                "squad_metrics: pass `models` — the provider/model ids of the grunt/drill " +
                "agents in your inventory (the `model:` of each line).",
            };
          }
          const data = await getMetrics();
          const now = Date.now();
          const limits = await getLimitMap();
          // How each model is paid for, read once for both views so the full
          // detail and the summary agree on it.
          const settings = loadModelSettings(directory);
          const notes = settings.found ? settings.models : null;
          const plans = settings.providers;
          const authTypes = loadAuthTypes();
          const ignored = settings.problems.length
            ? `\n\nmodel_data.json ignored (owner notes missing above):\n${settings.problems
                .map((p) => `  - ${p}`)
                .join("\n")}`
            : "";
          if (full === true) {
            const parts = await Promise.all(
              wanted.slice(0, MAX_FULL_MODELS).map(async (id) => {
                const llmbId =
                  lookup(id, data?.ids?.index)?.entry ??
                  Object.values(data?.scores?.byMetric ?? {})
                    .map((idx) => lookup(id, idx)?.entry.id)
                    .find(Boolean);
                const detail = llmbId
                  ? await fetchDetail({ fetch: globalThis.fetch, dir: METRICS_DIR, now, llmbId })
                  : null;
                return formatDetail(
                  id,
                  detail,
                  lookup(id, superindexOf(data) ?? {})?.entry ?? null,
                  {
                    context: limits[id] ?? null,
                    note: notes?.[id],
                    plans,
                    authTypes,
                  },
                );
              }),
            );
            return {
              content:
                "Every metric llmbenchmark.ai holds for these models, grouped by source and the " +
                "setting it was measured at; values are 0-1 unless a unit is shown. " +
                "SuperIndex: superindex.app (CC-BY-4.0).\n\n" +
                parts.join("\n\n") +
                ignored,
              metadata: { title: `metrics (full): ${Math.min(wanted.length, MAX_FULL_MODELS)}` },
            };
          }
          const models = wanted.map((id) => ({
            id,
            ...(limits[id] ? { context: limits[id] } : {}),
          }));
          return {
            content:
              formatSummary({
                models,
                roles: squadRoles(await getAgents()),
                notes,
                plans,
                authTypes,
                data,
                now,
              }) + ignored,
            metadata: { title: `metrics: ${models.length} model(s)` },
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
          // Untyped until validated: Code Mode can send anything.
          const raw = /** @type {Record<string, unknown>} */ (input ?? {});
          const { allow_remove: allowRemove, directory: asked, ...doc } = raw;
          const dir = typeof asked === "string" && asked ? asked : defaultAgentDir();
          // Code Mode does not enforce the schema's additionalProperties, and
          // a roster wrapped as {roster: {...}} used to read as "no agents" —
          // a 14-agent deletion the guard caught twice in one afternoon.
          if (doc.grunts === undefined && doc.drills === undefined) {
            const keys = Object.keys(doc);
            return {
              content:
                "Refused: pass `grunts` and/or `drills` at the TOP level of the input" +
                (keys.length ? ` (got ${keys.map((k) => `\`${k}\``).join(", ")})` : "") +
                ". Nothing was written.",
            };
          }
          const errors = validatePatchInput(raw);
          if (errors.length) {
            return { content: `Roster is invalid:\n${errors.map((e) => `  - ${e}`).join("\n")}` };
          }
          const valid = /** @type {SquadPatchInput} */ (raw);
          const roster = { grunts: valid.grunts ?? {}, drills: valid.drills ?? {} };
          const variantErrors = validateVariants(roster, await getVariantMap());
          if (variantErrors.length) {
            return {
              content: `Roster is invalid:\n${variantErrors.map((e) => `  - ${e}`).join("\n")}`,
            };
          }
          // Descriptions carry the owner's routing rules from model_data.json;
          // writing from an unreadable file would strip them from every agent.
          const problems = loadModelSettings(describerScope(dir, directory)).problems;
          if (problems.length) {
            return {
              content:
                "Refused: model_data.json cannot be read, and agent descriptions are built " +
                "from it — writing now would drop the owner's routing rules. Nothing was " +
                `written. Ask the user to fix:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
            };
          }
          const result = applySquad({
            roster,
            dir,
            allowRemove: allowRemove === true,
            describe: squadDescriber(dir, directory),
          });
          if (result.ok) {
            // The inventory lists the squad; let the next turn see the change.
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

    /** @typedef {{parentID: string, agent: string | null}} ChildInfo */
    /** @type {Map<string, ReturnType<typeof initGuardState>>} */
    const guardStates = new Map();
    /** @type {Map<string, ChildInfo | null>} null: not a subagent */
    const sessionInfo = new Map();
    /** @type {Map<string, number>} epoch ms */
    const lastActivity = new Map();
    /** @type {Map<string, ReturnType<typeof setInterval>>} */
    const pollTimers = new Map();
    /** @type {Set<string>} children with an execution in flight */
    const activeExecutions = new Set();

    /** @param {string} sessionID @returns {Promise<ChildInfo | null>} */
    const getSessionInfo = async (sessionID) => {
      const known = sessionInfo.get(sessionID);
      if (known !== undefined) return known;
      /** @type {ChildInfo | null} */
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

    /** @param {string} sessionID */
    const stopSilenceWatch = (sessionID) => {
      const timer = pollTimers.get(sessionID);
      if (timer) clearInterval(timer);
      pollTimers.delete(sessionID);
    };

    // Explain to the orchestrator why its subagent failed and that it should
    // reroute. Steered into the parent's running turn, so it lands right after
    // the failed subagent call; `resume` starts a turn if the parent is idle.
    /**
     * @param {string} parentID
     * @param {string | null} agentName
     * @param {Omit<Parameters<typeof formatGuardNote>[0], "model" | "provider">} result
     */
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
        interrupt: result.interrupt,
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

    // --- provider quota ---

    // Read off every subagent model response. The response itself is left
    // alone (headers only; the body is a live stream), and the hook returns at
    // once: the session lookup and the note run beside the transport, never
    // in front of it.
    const reportQuota = createQuotaReporter();
    await ctx.session.hook("http.response", (event) => {
      const providerID = event.model?.providerID;
      if (!providerID || event.kind !== "primary") return;
      /** @type {Record<string, string>} */
      const headers = {};
      try {
        event.response.headers.forEach((value, name) => {
          headers[name.toLowerCase()] = value;
        });
      } catch {
        return;
      }
      void (async () => {
        const info = await getSessionInfo(event.sessionID);
        if (!info) return; // the orchestrator's own calls: nobody to tell
        const clause = reportQuota(
          `${info.parentID}|${providerID}`,
          providerID,
          headers,
          Date.now(),
        );
        if (!clause) return;
        await ctx.session.synthetic({
          sessionID: info.parentID,
          text: clause,
          description: "squad provider quota",
          delivery: "steer",
          resume: false,
        });
      })().catch(() => {
        // Best-effort: a lost note costs a routing hint, nothing else.
      });
    });

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

    /** @param {string} sessionID */
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
        // The parent is told what actually happened: a failed interrupt leaves
        // a child that may still be running, and redispatching it then puts
        // two agents on one task.
        /** @type {"confirmed" | "idle" | "unconfirmed"} */
        let interrupt = "unconfirmed";
        try {
          const res = unwrap(await ctx.session.interrupt({ sessionID, resume: false }));
          if (res?.interrupted === true) interrupt = "confirmed";
          else if (res?.interrupted === false) interrupt = "idle";
        } catch {
          // Stays "unconfirmed".
        }
        await sendGuardNote(info.parentID, info.agent, {
          reason: "silent_hang",
          silentMs: Date.now() - last,
          interrupt,
        });
      }, SILENCE_POLL_INTERVAL_MS);
      timer.unref?.();
      pollTimers.set(sessionID, timer);
    };

    /**
     * @param {string} sessionID
     * @param {{type?: unknown, message?: unknown, status?: unknown} | undefined} error
     */
    const handleTerminalError = async (sessionID, error) => {
      if (!guardConfig.enabled) return;
      const state = guardStates.get(sessionID);
      if (state?.guarded) return; // already handled by the retry hook
      const info = await getSessionInfo(sessionID);
      if (!info) return;
      const text = errorText(error);
      if (
        !isGuardedTerminalError(
          text,
          guardConfig,
          typeof error?.status === "number" ? error.status : undefined,
        )
      )
        return;
      guardStates.set(sessionID, { ...(state ?? initGuardState()), guarded: true });
      await sendGuardNote(info.parentID, info.agent, { reason: "terminal_error", errorText: text });
    };

    // A child resumed by session id starts a new execution without a new
    // session.created, so each execution arms its own silence window and
    // starts with clean retry state — a `guarded` flag left by the previous
    // execution would otherwise stop the new watcher on its first tick and
    // make handleTerminalError skip a real failure.
    /** @param {string} sessionID */
    const armExecution = async (sessionID) => {
      activeExecutions.add(sessionID);
      const info = await getSessionInfo(sessionID);
      if (!info) return; // top-level session — never guarded
      // The execution may have ended while the session lookup was in flight.
      if (!activeExecutions.has(sessionID)) return;
      guardStates.delete(sessionID);
      lastActivity.set(sessionID, Date.now());
      startSilenceWatch(sessionID);
    };

    /** @param {string} sessionID */
    const forget = (sessionID) => {
      activeExecutions.delete(sessionID);
      guardStates.delete(sessionID);
      sessionInfo.delete(sessionID);
      lastActivity.delete(sessionID);
      stopSilenceWatch(sessionID);
    };

    const events = new AbortController();
    if (guardConfig.enabled) {
      void (async () => {
        for await (const event of ctx.event.subscribe({ signal: events.signal })) {
          const data = /** @type {Record<string, unknown> | undefined} */ (event?.data);
          const sessionID = data?.sessionID;
          if (typeof sessionID !== "string") continue;
          // Any event naming a watched session is proof of life.
          if (pollTimers.has(sessionID)) lastActivity.set(sessionID, Date.now());
          switch (event.type) {
            case "session.created": {
              const { parentID, agent } = event.data;
              if (parentID) {
                sessionInfo.set(sessionID, { parentID, agent: agent ?? null });
                lastActivity.set(sessionID, Date.now());
                startSilenceWatch(sessionID);
              }
              break;
            }
            case "session.execution.started":
              void armExecution(sessionID);
              break;
            case "session.deleted":
              forget(sessionID);
              break;
            case "session.execution.succeeded":
            case "session.execution.interrupted":
              activeExecutions.delete(sessionID);
              stopSilenceWatch(sessionID);
              break;
            case "session.execution.failed":
              activeExecutions.delete(sessionID);
              stopSilenceWatch(sessionID);
              void handleTerminalError(sessionID, event.data.error);
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
