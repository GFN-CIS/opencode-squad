#!/usr/bin/env node
// Build model_data.json — the per-squad-model performance snapshot the
// orchestrator inventory reads instead of the raw AA dump.
//
// Usage:
//   node squad-file-performance.mjs [--dir <agentDir>] [--out <file>]
//
// Scans the agent dir for grunt-/drill- agents, collects the models they
// target, copies the decision-useful Artificial Analysis indices from
// src/benchmarks.json, and writes them — plus a hand-editable `info` field —
// to model_data.json next to the agent dir (global: ~/.config/opencode/).
//
// MANUAL ONLY by design: opencode never runs this. Re-running refreshes the
// perf numbers but PRESERVES your `info` edits (and any other field you add).
// Caveat: hand-edited PERF numbers ARE overwritten on re-run — only non-perf
// fields (info, …) survive the merge.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { buildModelData, readModelData } from "../src/model-data.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const BENCHMARKS = path.join(PACKAGE_ROOT, "src", "benchmarks.json");

function parseArgs(argv) {
  let dir = path.join(os.homedir(), ".config", "opencode", "agent");
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") dir = argv[++i];
    else if (a === "--out") out = argv[++i];
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  // model_data.json sits beside the agent dir (its parent config dir), unless
  // the user pins an explicit --out.
  if (!out) out = path.join(path.dirname(path.resolve(dir)), "model_data.json");
  return { dir, out };
}

function main() {
  const { dir, out } = parseArgs(process.argv.slice(2));

  let benchmarksModels;
  try {
    benchmarksModels = JSON.parse(fs.readFileSync(BENCHMARKS, "utf8")).models;
  } catch (e) {
    console.error(`Cannot read benchmarks at ${BENCHMARKS}: ${e.message}`);
    process.exit(1);
  }

  const existing = readModelData(out) || {};
  const generated = new Date().toISOString().slice(0, 10);
  const snapshot = buildModelData(dir, benchmarksModels, existing, generated);

  const ids = Object.keys(snapshot.models);
  if (ids.length === 0) {
    console.error(
      `No grunt-/drill- agents found in ${dir}. Draft a squad first ` +
        `(squad-draft), then re-run. Nothing written.`,
    );
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(snapshot, null, 2) + "\n");

  const unmatched = ids.filter((id) => snapshot.models[id].intelligence == null);
  console.log(`Agent dir: ${dir}`);
  console.log(`Wrote ${out}: ${ids.length} model(s).`);
  for (const id of ids) {
    const e = snapshot.models[id];
    const perf = e.intelligence == null ? "no AA match" : `intel ${e.intelligence}`;
    const note = e.info ? ` · info: "${e.info}"` : "";
    console.log(`  ${id}  (${perf})${note}`);
  }
  if (unmatched.length) {
    console.log(
      `\n${unmatched.length} model(s) had no AA match — fill their perf/info ` +
        `by hand: ${unmatched.join(", ")}`,
    );
  }
  console.log(
    "\n`info` and any hand-added fields are preserved on re-run; perf indices " +
      "are refreshed from benchmarks. Edit freely, then reload opencode.",
  );
}

main();
