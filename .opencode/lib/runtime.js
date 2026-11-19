// Process-wide state and file-backed lookups for the OpenCode 2 plugin.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../../src/fs-atomic.js";
import { billingFor, ownerRules } from "../../src/metrics.js";
import { metricsDir, readMetrics, refreshMetrics } from "../../src/metrics-cache.js";
import { buildModelData, modelsChanged, readModelDataFile } from "../../src/model-data.js";
import { opencodeConfigDir, opencodeDataDir } from "../../src/paths.js";
import { createPromptLoader } from "../../src/prompt-inject.js";
import { rosterCollisions } from "../../src/squad-agents.js";
import { defaultAgentDir, readLegacySquad } from "../../src/squad-apply.js";
import { defaultStoreFile, readStore, writeStore } from "../../src/squad-store.js";
import { describeAgent } from "../../src/workers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "../..");
export const SKILLS_DIR = path.join(PACKAGE_ROOT, "skills");

// The primary agent that acts as the orchestrator. The bootstrap goes into this
// agent's system prompt only (the context hook carries its agent id).
export const ORCHESTRATOR_AGENT = "build";

// Serves the CURRENT bundled role prompt to every generated grunt/drill agent,
// overriding the copy frozen into its file when the squad was drafted. Cached
// on (size, mtime) so an edit to prompts/<role>.md goes live without a restart
// while costing one stat per request instead of a read. See src/prompt-inject.js.
export const loadRolePrompt = createPromptLoader({
  readFile: (role) => fs.readFileSync(path.join(PACKAGE_ROOT, "prompts", `${role}.md`), "utf8"),
  statKey: (role) => {
    const st = fs.statSync(path.join(PACKAGE_ROOT, "prompts", `${role}.md`));
    return `${st.size}:${st.mtimeMs}`;
  },
});

// Live model metrics (src/metrics-cache.js), cached in the OS temp dir.
// One refresher per process — the OpenCode 2 service is long-lived and hosts
// several projects. The first refresh starts at load; each fetch carries its
// own short timeout, so a one-shot `opencode run` is held up by at most that.
// Afterwards a timer re-checks every few hours and refetches only what is
// older than the TTL. Timers are unref'd so they never keep the process alive.
export const METRICS_DIR = metricsDir();
const METRICS_CHECK_INTERVAL_MS = 4 * 3600_000;
/** @type {Promise<unknown> | null} */
let _metricsInflight = null;
/** @type {ReturnType<typeof setInterval> | undefined} */
let _metricsTimer;

function refreshMetricsNow() {
  _metricsInflight ??= refreshMetrics({
    fetch: globalThis.fetch,
    dir: METRICS_DIR,
    now: Date.now(),
  })
    .catch(() => undefined)
    .finally(() => {
      _metricsInflight = null;
    });
  return _metricsInflight;
}

export function startMetricsRefresh() {
  if (_metricsTimer) return;
  void refreshMetricsNow();
  _metricsTimer = setInterval(() => void refreshMetricsNow(), METRICS_CHECK_INTERVAL_MS);
  _metricsTimer.unref?.();
}

/**
 * The cached metrics. If there are none yet and a refresh is in flight,
 * wait for it — but no longer than `waitMs`.
 *
 * @param {number} [waitMs]
 */
export async function getMetrics(waitMs = 10_000) {
  const have = readMetrics(METRICS_DIR);
  if (have || !_metricsInflight) return have;
  await Promise.race([
    _metricsInflight,
    new Promise((resolve) => setTimeout(resolve, waitMs).unref?.()),
  ]);
  return readMetrics(METRICS_DIR);
}

// Hand-editable model_data.json, looked for beside the agent dirs opencode
// merges: the project's .opencode and the global config dir. One read serves
// both sections, so `models` and `providers` always come from the same
// version of each file; project entries win over global ones key by key.
// `directory: null` reads the global file only.
//
// Cached on the files' (mtime, size), not for the process lifetime: the
// desktop service lives for hours, and a forever-cache meant an edited `info`
// reached nobody until a restart. Keyed by project directory: one OpenCode 2
// service process hosts plugin instances for several projects, and its cwd is
// none of them.
//
// A file that exists but cannot be parsed contributes nothing and is listed in
// `problems` (path and cause, never its contents), so callers that would
// derive owner-visible output from it can refuse instead of silently dropping
// the owner's rules.
/** @typedef {{models: Record<string, any>, providers: Record<string, any>, found: boolean, problems: string[]}} ModelSettings */
/** @type {Map<string|null, {sig: string, settings: ModelSettings}>} */
const _modelSettingsCache = new Map();
const globalModelDataFile = () =>
  path.join(opencodeConfigDir(process.env, os.homedir()), "model_data.json");
/** @param {string|null} directory */
const modelDataFiles = (directory) => [
  globalModelDataFile(),
  ...(directory ? [path.join(directory, ".opencode", "model_data.json")] : []),
];
/** @param {string} file */
const statSig = (file) => {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "-";
  }
};

/**
 * @param {string|null} [directory] project root; defaults to the process cwd
 * @returns {ModelSettings}
 */
export function loadModelSettings(directory = process.cwd()) {
  const files = modelDataFiles(directory);
  const sig = files.map(statSig).join("|");
  const hit = _modelSettingsCache.get(directory);
  if (hit?.sig === sig) return hit.settings;
  /** @type {ModelSettings} */
  const settings = { models: {}, providers: {}, found: false, problems: [] };
  // Global first, then project on top.
  for (const file of files) {
    const read = readModelDataFile(file);
    if (read.state === "missing") continue;
    if (read.state === "invalid") {
      settings.problems.push(`${file}: ${read.reason}`);
      continue;
    }
    settings.found = true;
    Object.assign(settings.models, read.data.models);
    Object.assign(settings.providers, read.data.providers ?? {});
  }
  _modelSettingsCache.set(directory, { sig, settings });
  return settings;
}

// provider -> "oauth" | "api" | ... from opencode's auth store. Only the type
// is read out; credentials never leave this function.
export function loadAuthTypes() {
  try {
    const file = path.join(opencodeDataDir(process.env, os.homedir()), "auth.json");
    const auth = JSON.parse(fs.readFileSync(file, "utf8"));
    return Object.fromEntries(
      Object.entries(auth ?? {}).map(([provider, v]) => [provider, String(v?.type ?? "")]),
    );
  } catch {
    return {};
  }
}

/**
 * Startup auto-regen of the GLOBAL model_data.json: list the squad's models
 * (from squad.json), MERGE (preserving every hand-written field, dropping
 * legacy AA perf fields), and write ONLY when the models actually changed —
 * so a new grunt/drill lands automatically without clobbering edits or
 * churning the file every boot. No-op when there is no squad yet.
 *
 * A model_data.json that exists but does not parse is LEFT ALONE: treating it
 * as missing once overwrote a hand-edited file with a fresh skeleton, losing
 * every owner rule and provider plan in it. So is everything when squad.json
 * cannot be read: the merge would drop every model's entry. Never throws —
 * startup must not break.
 *
 * @returns {{wrote: boolean, problem?: string}}
 */
export function ensureGlobalModelDataFresh() {
  const file = globalModelDataFile();
  try {
    const read = readModelDataFile(file);
    if (read.state === "invalid") {
      const problem = `${file}: ${read.reason}`;
      console.warn(`[opencode-squad] model_data.json left untouched — ${problem}`);
      return { wrote: false, problem };
    }
    const store = readStore(defaultStoreFile());
    if (store.state === "invalid") {
      const problem = `${defaultStoreFile()}: ${store.reason}`;
      console.warn(`[opencode-squad] model_data.json left untouched — ${problem}`);
      return { wrote: false, problem };
    }
    if (store.state === "missing") return { wrote: false }; // no squad
    const ids = [
      ...new Set([...Object.keys(store.roster.grunts), ...Object.keys(store.roster.drills)]),
    ].sort();
    const existing = read.state === "ok" ? read.data : {};
    const generated = new Date().toISOString().slice(0, 10);
    const snapshot = buildModelData(ids, existing, generated);
    if (Object.keys(snapshot.models).length === 0) return { wrote: false }; // no squad
    if (!modelsChanged(existing, snapshot)) return { wrote: false }; // unchanged
    writeFileAtomic(file, `${JSON.stringify(snapshot, null, 2)}\n`);
    return { wrote: true };
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    const problem = `${file}: ${err?.code ?? err?.name ?? "error"}`;
    console.warn(`[opencode-squad] model_data.json refresh failed — ${problem}`);
    return { wrote: false, problem };
  }
}

/**
 * First start after #85: a squad that earlier versions wrote as agent files
 * becomes squad.json. Only when squad.json does not exist yet, and only when
 * every generated file could be read: an import that dropped an unreadable
 * agent would look like a squad the user chose. The files are left in place;
 * the plugin hides the agents they define once the roster no longer holds
 * them. Never throws.
 *
 * @returns {{imported: number, problems: string[]}}
 */
export function importLegacySquad() {
  const store = defaultStoreFile();
  try {
    if (readStore(store).state !== "missing") return { imported: 0, problems: [] };
    const legacy = readLegacySquad(defaultAgentDir());
    if (legacy.problems.length) {
      for (const p of legacy.problems) {
        console.warn(`[opencode-squad] legacy squad not imported — ${p}`);
      }
      return { imported: 0, problems: legacy.problems };
    }
    // Two files whose models map to one agent id: importing both would
    // register only one of them (#90).
    const clashes = rosterCollisions(legacy.roster).map(
      (c) => `${c.entries.join(" and ")} map to the same agent id ${c.id}; delete one of the files`,
    );
    if (clashes.length) {
      for (const p of clashes) console.warn(`[opencode-squad] legacy squad not imported — ${p}`);
      return { imported: 0, problems: clashes };
    }
    const count =
      Object.keys(legacy.roster.grunts).length + Object.keys(legacy.roster.drills).length;
    if (count === 0) return { imported: 0, problems: [] };
    writeStore(store, legacy.roster);
    return { imported: count, problems: [] };
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    const problem = `${store}: ${err?.code ?? err?.name ?? "error"}`;
    console.warn(`[opencode-squad] legacy squad import failed — ${problem}`);
    return { imported: 0, problems: [problem] };
  }
}

/**
 * describe(role, modelId) for the squad, from the GLOBAL model_data.json: the
 * squad is global, and with project overrides its descriptions would flip with
 * whichever project's instance registered last.
 *
 * @returns {(role: "grunt"|"drill", modelId: string) => string}
 */
export function squadDescriber() {
  return describerFrom(loadModelSettings(null));
}

/**
 * @param {ModelSettings} settings
 * @returns {(role: "grunt"|"drill", modelId: string) => string}
 */
function describerFrom({ models, providers }) {
  const authTypes = loadAuthTypes();
  return (role, modelId) =>
    describeAgent(role, {
      rules: ownerRules(modelId, { note: models[modelId], providers }),
      billing: billingFor(modelId, { note: models[modelId], plans: providers, authTypes }),
    });
}
