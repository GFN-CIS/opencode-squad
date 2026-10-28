// Process-wide state and file-backed lookups for the OpenCode 2 plugin.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHECK_INTERVAL_MS,
  cacheDir,
  loadSnapshot,
  refreshOnce,
} from "../../src/benchmark-cache.js";
import { formatBench } from "../../src/benchmarks.js";
import { createTurnMemo } from "../../src/message-transform.js";
import { buildModelData, formatPerf, modelsChanged, readModelData } from "../../src/model-data.js";
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

// AA benchmark snapshot (models object), read once per process: the fresher of
// the bundled copy and the one the background refresher downloaded. Fixed for
// the process lifetime on purpose — see src/benchmark-cache.js. null if neither
// is usable.
const BENCH_CACHE_DIR = cacheDir(process.env, os.homedir());
let _benchCache; // undefined = not loaded
let _bundledModelCount = 0;
function loadBenchmarks() {
  if (_benchCache !== undefined) return _benchCache;
  _benchCache = null;
  const { snapshot, bundledCount } = loadSnapshot(
    path.join(PACKAGE_ROOT, "src", "benchmarks.json"),
    BENCH_CACHE_DIR,
  );
  _bundledModelCount = bundledCount;
  if (snapshot) {
    _benchCache = snapshot.models;
  }
  return _benchCache;
}

// Background benchmark refresh: first check shortly after startup, then hourly
// (refreshOnce itself enforces the once-a-day / 5-failures throttle). The first
// check is delayed so a one-shot `opencode run` exits before any socket is
// opened. Fire-and-forget under a
// hard fetch timeout, so opencode never waits on GitHub; timers are unref'd so
// they never keep the process alive. Started once per process.
const BENCH_FIRST_CHECK_MS = 30_000;
let _benchTimer;
export function startBenchmarkRefresh() {
  if (_benchTimer) return;
  loadBenchmarks(); // pin the in-use snapshot before the refresher can replace the cache
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await refreshOnce({
        fetch: globalThis.fetch,
        dir: BENCH_CACHE_DIR,
        now: Date.now(),
        minModels: Math.ceil(_bundledModelCount / 2),
      });
    } catch {
      // Best-effort; the next tick tries again.
    } finally {
      busy = false;
    }
  };
  _benchTimer = setTimeout(() => {
    void tick();
    _benchTimer = setInterval(tick, CHECK_INTERVAL_MS);
    _benchTimer.unref?.();
  }, BENCH_FIRST_CHECK_MS);
  _benchTimer.unref?.();
}

// Hand-editable per-squad-model snapshot, keyed by opencode provider/model id.
// Looked for beside the agent dirs opencode merges: the project's .opencode
// first, then the global config dir. null if neither exists (we then fall back
// to the raw AA benchmarks). Read once per process.
// Keyed by project directory: one OpenCode 2 service process hosts plugin
// instances for several projects, and its cwd is none of them.
const _modelDataCache = new Map(); // directory -> merged models | null
/** @param {string} [directory] project root; defaults to the process cwd */
export function loadModelData(directory = process.cwd()) {
  if (_modelDataCache.has(directory)) return _modelDataCache.get(directory);
  const candidates = [
    path.join(directory, ".opencode", "model_data.json"),
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
  _modelDataCache.set(directory, found ? merged : null);
  return _modelDataCache.get(directory);
}

// Per-model capability tail for the inventory: model_data entry if we have one
// (precomputed indices + hand-written note), else the raw AA benchmark lookup.
/** @param {string} [directory] see loadModelData */
export function buildPerfLookup(directory) {
  const modelData = loadModelData(directory);
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
export function ensureGlobalModelDataFresh() {
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
