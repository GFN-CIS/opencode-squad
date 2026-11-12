// Process-wide state and file-backed lookups for the OpenCode 2 plugin.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTurnMemo } from "../../src/message-transform.js";
import { metricsDir, readMetrics, refreshMetrics } from "../../src/metrics-cache.js";
import { buildModelData, modelsChanged, readModelData } from "../../src/model-data.js";
import { opencodeConfigDir, opencodeDataDir } from "../../src/paths.js";
import { createPromptLoader } from "../../src/prompt-inject.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "../..");
export const SKILLS_DIR = path.join(PACKAGE_ROOT, "skills");

// The primary agent that acts as the orchestrator. Injection targets only this
// agent's sessions (the context hook carries its agent id).
export const ORCHESTRATOR_AGENT = "build";

// Holds the rendered injection block for the turn in flight, so every model
// call within one turn sends byte-identical text and the provider's prompt
// cache survives. See createTurnMemo for the measurements behind it.
export const turnMemo = createTurnMemo();

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

// Hand-editable per-squad-model snapshot, keyed by opencode provider/model id.
// Looked for beside the agent dirs opencode merges: the project's .opencode
// first, then the global config dir. null if neither exists. Read once per process.
// Keyed by project directory: one OpenCode 2 service process hosts plugin
// instances for several projects, and its cwd is none of them.
const _modelDataCache = new Map(); // directory -> merged models | null
/** @param {string} [directory] project root; defaults to the process cwd */
export function loadModelData(directory = process.cwd()) {
  if (_modelDataCache.has(directory)) return _modelDataCache.get(directory);
  const candidates = [
    path.join(directory, ".opencode", "model_data.json"),
    path.join(opencodeConfigDir(process.env, os.homedir()), "model_data.json"),
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
  _modelDataCache.set(directory, found ? merged : null);
  return _modelDataCache.get(directory);
}

// Plans per provider from model_data.json `providers` (project over global).
// Read on every call: it is tiny, and an edit should apply without a restart.
/** @param {string} [directory] see loadModelData */
export function loadProviderPlans(directory = process.cwd()) {
  const plans = {};
  for (const file of [
    path.join(opencodeConfigDir(process.env, os.homedir()), "model_data.json"),
    path.join(directory, ".opencode", "model_data.json"),
  ]) {
    Object.assign(plans, readModelData(file)?.providers ?? {});
  }
  return plans;
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

// Startup auto-regen of the GLOBAL model_data.json: rescan the squad, MERGE
// (preserving every hand-written field, dropping legacy AA perf fields), and
// write ONLY when the models actually changed — so a new grunt/drill lands
// automatically without clobbering edits or churning the file every boot.
// Best-effort: any failure is swallowed so it can never break startup. No-op
// when there is no squad yet (0 models). Only the global agent dir is scanned;
// a project's .opencode/model_data.json is edited by hand only.
export function ensureGlobalModelDataFresh() {
  try {
    const configDir = opencodeConfigDir(process.env, os.homedir());
    const agentDir = path.join(configDir, "agent");
    const file = path.join(configDir, "model_data.json");
    const existing = readModelData(file) || {};
    const generated = new Date().toISOString().slice(0, 10);
    const snapshot = buildModelData(agentDir, existing, generated);
    if (Object.keys(snapshot.models).length === 0) return; // no squad -> nothing
    if (!modelsChanged(existing, snapshot)) return; // unchanged -> no write
    fs.writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  } catch {
    // Best-effort; nothing reads perf from this file any more.
  }
}
