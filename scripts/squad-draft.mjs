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
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildRoster,
  diffRoster,
  parseAgentFrontmatter,
  ROSTER_SCHEMA,
  ROSTER_VERSION,
  validateRoster,
} from "../src/roster.js";
import { agentMarkdown, GENERATED_MARKER_DETECT, parseRosterEntry } from "../src/workers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const PROMPTS = {
  grunt: path.join(PACKAGE_ROOT, "prompts", "grunt.md"),
  drill: path.join(PACKAGE_ROOT, "prompts", "drill.md"),
};
const ROLES = ["grunt", "drill"];
const GENERATED_FILE_RE = /^(?:grunt|drill|worker)-.*\.md$/;

function parseArgs(argv) {
  const models = [];
  let dir = path.join(os.homedir(), ".config", "opencode", "agent");
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

/**
 * Read the squad that currently exists, from the generated agent files. Only
 * files carrying our marker count — a hand-authored `grunt-something.md` is
 * somebody else's and is neither exported nor pruned.
 */
function readCurrent(dir) {
  const entries = [];
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return { entries, files: new Map() };
  }
  const byModel = new Map();
  for (const f of files) {
    if (!GENERATED_FILE_RE.test(f)) continue;
    let txt;
    try {
      txt = fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    if (!txt.includes(GENERATED_MARKER_DETECT)) continue;
    const { modelId, variant } = parseAgentFrontmatter(txt);
    if (!modelId) continue;
    entries.push({ modelId, variant });
    if (!byModel.has(modelId)) byModel.set(modelId, []);
    byModel.get(modelId).push(f);
  }
  return { entries, files: byModel };
}

function applyRoster({ roster, dir, allowRemove }) {
  const { entries, files } = readCurrent(dir);
  const { roster: current, conflicts } = buildRoster(entries);
  const diff = diffRoster(current, roster);

  if (diff.removed.length > 0 && !allowRemove) {
    console.error(
      `Refusing to apply: this would REMOVE ${diff.removed.length} model(s) from the squad:`,
    );
    for (const id of diff.removed) console.error(`  - ${id}`);
    console.error(
      "\nIf that is what you meant, re-run with --allow-remove. If you meant to ADD a model,\n" +
        "start from `--export` and edit that roster rather than writing a new one.",
    );
    process.exit(1);
  }

  const body = Object.fromEntries(ROLES.map((r) => [r, fs.readFileSync(PROMPTS[r], "utf8")]));
  fs.mkdirSync(dir, { recursive: true });

  const written = [];
  for (const entry of roster.models) {
    for (const role of ROLES) {
      const { filename, content } = agentMarkdown(role, entry.id, body[role], {
        variant: entry.variant,
      });
      fs.writeFileSync(path.join(dir, filename), content);
      written.push({ id: entry.id, variant: entry.variant, filename });
    }
  }

  const pruned = [];
  for (const id of diff.removed) {
    for (const f of files.get(id) ?? []) {
      fs.unlinkSync(path.join(dir, f));
      pruned.push(f);
    }
  }

  console.log(`Agent dir: ${dir}`);
  for (const c of conflicts) console.log(`  note   ${c}`);
  for (const w of written) {
    console.log(`  wrote  ${w.filename}   (${w.id}${w.variant ? `, variant: ${w.variant}` : ""})`);
  }
  for (const f of pruned) console.log(`  pruned ${f}`);
  console.log(
    `\n+${diff.added.length} added, -${diff.removed.length} removed, ` +
      `~${diff.changed.length} changed, =${diff.unchanged.length} unchanged.`,
  );
  for (const a of diff.added) console.log(`  + ${a}`);
  for (const c of diff.changed) console.log(`  ~ ${c}`);
  for (const r of diff.removed) console.log(`  - ${r}`);
  const variants = written.filter((w) => w.variant);
  if (variants.length) {
    console.log(
      "\nVariants written (opencode ignores an unrecognized one WITHOUT error — check these\n" +
        "against each model's `reasoning_options` in models.dev):",
    );
    for (const m of roster.models.filter((m) => m.variant))
      console.log(`  ${m.id} -> ${m.variant}`);
  }
  console.log("\nReload opencode (restart the TUI / start a new run) to pick up the new agents.");
}

function main() {
  const { models, dir, allowRemove, mode, rosterFile } = parseArgs(process.argv.slice(2));

  if (mode === "schema") {
    console.log(JSON.stringify(ROSTER_SCHEMA, null, 2));
    return;
  }

  if (mode === "export") {
    const { entries } = readCurrent(dir);
    const { roster, conflicts } = buildRoster(entries);
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
    applyRoster({ roster: doc, dir, allowRemove });
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
  applyRoster({ roster, dir, allowRemove });
}

main();
