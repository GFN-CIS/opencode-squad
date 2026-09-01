#!/usr/bin/env node
// Scaffold the per-model squad — a grunt AND a drill per model — from a roster.
//
// Usage:
//   node squad-draft.mjs [--dir <agentDir>] --export
//   node squad-draft.mjs --schema
//   node squad-draft.mjs [--dir <agentDir>] --apply <roster.json> [--allow-remove]
//   node squad-draft.mjs [--dir <agentDir>] [--allow-remove] <provider/model[@variant]>...
//
// The roster is read-modify-write: `--export` prints the CURRENT squad as JSON
// (derived from the agent files themselves, never from a stored manifest, so
// there is nothing to desync), you edit the entry you mean, and `--apply` writes
// it back. `--schema` prints the JSON Schema for that document.
//
// A roster entry may carry a reasoning variant — `zai-coding-plan/glm-5.3@high`
// positionally, or `"variant": "high"` in the JSON — which becomes `variant:`
// in both generated agents. Valid levels are per-model, from that model's
// `reasoning_options` in models.dev; opencode SILENTLY IGNORES one it doesn't
// recognize, so every variant written is echoed in the report for you to check.
//
// Removals need `--allow-remove`. Applying a roster is declarative, so a caller
// that rebuilds it from memory rather than editing the exported one would
// otherwise delete the rest of the squad without saying so — which is exactly
// how this script used to wipe a squad when asked to add one model to it.
// Hand-authored agents are never touched in any mode.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ROSTER_SCHEMA, ROSTER_VERSION, validateRoster } from "../src/roster.js";
import { applySquad, defaultAgentDir, formatApplyReport, readSquad } from "../src/squad-apply.js";
import { parseRosterEntry } from "../src/workers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const models = [];
  let dir = defaultAgentDir();
  let allowRemove = false;
  let mode = "apply-positional";
  let rosterFile;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") dir = argv[++i];
    else if (a === "--allow-remove" || a === "--prune") allowRemove = true;
    else if (a === "--export") mode = "export";
    else if (a === "--schema") mode = "schema";
    else if (a === "--apply") {
      mode = "apply-file";
      rosterFile = argv[++i];
    } else if (a === "--no-prune") {
      // Accepted and ignored: not pruning is now the default. Kept so older
      // invocations (and the docs they came from) keep working.
    } else if (a.startsWith("--")) {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    } else models.push(a);
  }
  return { models, dir, allowRemove, mode, rosterFile };
}

/** Apply, print the shared report, and exit non-zero when the apply was refused. */
function run({ roster, dir, allowRemove }) {
  const result = applySquad({ roster, dir, allowRemove, packageRoot: PACKAGE_ROOT });
  const report = formatApplyReport(result);
  if (!result.ok) {
    console.error(report);
    process.exit(1);
  }
  console.log(report);
}

function main() {
  const { models, dir, allowRemove, mode, rosterFile } = parseArgs(process.argv.slice(2));

  if (mode === "schema") {
    console.log(JSON.stringify(ROSTER_SCHEMA, null, 2));
    return;
  }

  if (mode === "export") {
    const { roster, conflicts } = readSquad(dir);
    for (const c of conflicts) console.error(`note: ${c}`);
    console.log(JSON.stringify(roster, null, 2));
    return;
  }

  if (mode === "apply-file") {
    if (!rosterFile) {
      console.error("--apply needs a path to a roster JSON file (or - for stdin)");
      process.exit(2);
    }
    let doc;
    const raw =
      rosterFile === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(rosterFile, "utf8");
    try {
      doc = JSON.parse(raw);
    } catch (err) {
      console.error(`Roster is not valid JSON: ${err.message}`);
      process.exit(2);
    }
    const errors = validateRoster(doc);
    if (errors.length) {
      console.error("Roster is invalid:");
      for (const e of errors) console.error(`  - ${e}`);
      console.error("\nRun --schema for the expected shape.");
      process.exit(2);
    }
    run({ roster: doc, dir, allowRemove });
    return;
  }

  if (models.length === 0) {
    console.error(
      "Nothing to do. Usage:\n" +
        "  squad-draft.mjs [--dir <d>] --export\n" +
        "  squad-draft.mjs --schema\n" +
        "  squad-draft.mjs [--dir <d>] --apply <roster.json> [--allow-remove]\n" +
        "  squad-draft.mjs [--dir <d>] [--allow-remove] <provider/model[@variant]>...",
    );
    process.exit(2);
  }

  // Positional form. It goes through the same apply path — and therefore the
  // same removal guard — so the short invocation cannot wipe a squad either.
  const roster = { version: ROSTER_VERSION, models: [] };
  for (const entry of models) {
    const { modelId, variant } = parseRosterEntry(entry);
    roster.models.push(variant ? { id: modelId, variant } : { id: modelId });
  }
  const errors = validateRoster(roster);
  if (errors.length) {
    console.error("Bad model list:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(2);
  }
  run({ roster, dir, allowRemove });
}

main();
