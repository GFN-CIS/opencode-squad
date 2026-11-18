// Process-wide state and file-backed lookups for the OpenCode 2 plugin.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../../src/fs-atomic.js";
import { billingFor, ownerRules } from "../../src/metrics.js";
import { metricsDir, readMetrics, refreshMetrics } from "../../src/metrics-cache.js";
import {
  buildModelData,
  modelsChanged,
  readModelDataFile,
  scanSquadModels,
} from "../../src/model-data.js";
import { opencodeConfigDir, opencodeDataDir } from "../../src/paths.js";
import { createPromptLoader } from "../../src/prompt-inject.js";
import { defaultAgentDir, syncDescriptions } from "../../src/squad-apply.js";
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
 * Startup auto-regen of the GLOBAL model_data.json: rescan the squad, MERGE
 * (preserving every hand-written field, dropping legacy AA perf fields), and
 * write ONLY when the models actually changed — so a new grunt/drill lands
 * automatically without clobbering edits or churning the file every boot.
 * No-op when there is no squad yet (0 models). Only the global agent dir is
 * scanned; a project's .opencode/model_data.json is edited by hand only.
 *
 * A file that exists but does not parse is LEFT ALONE: treating it as missing
 * once overwrote a hand-edited file with a fresh skeleton, losing every owner
 * rule and provider plan in it. Never throws — startup must not break.
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
    const agentDir = path.join(path.dirname(file), "agent");
    // A squad file whose model cannot be determined (unreadable, or a cut-off
    // or broken header) has an unknown model; the merge would drop that
    // model's entry and its owner rules with it. One scan feeds both the check
    // and the snapshot, so the snapshot is built from what was checked.
    const scan = scanSquadModels(agentDir);
    if (scan.unreadable.length || scan.undetermined.length) {
      const why = [
        ...(scan.unreadable.length ? [`cannot read ${scan.unreadable.join(", ")}`] : []),
        ...(scan.undetermined.length ? [`no model in ${scan.undetermined.join(", ")}`] : []),
      ];
      const problem = `${agentDir}: ${why.join("; ")}`;
      console.warn(`[opencode-squad] model_data.json left untouched — ${problem}`);
      return { wrote: false, problem };
    }
    const existing = read.state === "ok" ? read.data : {};
    const generated = new Date().toISOString().slice(0, 10);
    const snapshot = buildModelData(scan.ids, existing, generated);
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
 * describe(role, modelId) for the squad in `agentDir`, from model_data.json.
 * The GLOBAL agent dir — shared by every project — reads the global file only:
 * with project overrides the shared files would flip with whichever project
 * started last. A project's own agent dir also sees that project's file.
 *
 * @param {string} agentDir
 * @param {string} [directory]  project root
 */
export function squadDescriber(agentDir, directory) {
  return describerFrom(loadModelSettings(describerScope(agentDir, directory)));
}

/**
 * The model_data scope that feeds an agent dir's descriptions.
 *
 * @param {string} agentDir
 * @param {string} [directory]
 */
export function describerScope(agentDir, directory) {
  return path.resolve(agentDir) === path.resolve(defaultAgentDir()) ? null : (directory ?? null);
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

// Startup: rewrite the global squad's descriptions from model_data.json, so an
// edited `info` or plan reaches the orchestrator with a restart instead of a
// re-draft (opencode reloads agent files live). Best-effort, like the regen.
//
// Skipped while the global model_data.json is unreadable: describing from it
// then would rewrite every agent without its owner rules.
export function syncGlobalSquadDescriptions() {
  try {
    const settings = loadModelSettings(null);
    if (settings.problems.length) return [];
    return syncDescriptions({ dir: defaultAgentDir(), describe: describerFrom(settings) });
  } catch {
    return [];
  }
}
