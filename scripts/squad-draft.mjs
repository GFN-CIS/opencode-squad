#!/usr/bin/env node
// Scaffold the per-model squad — a grunt AND a drill per model — from one list.
//
// Usage:
//   node squad-draft.mjs [--dir <agentDir>] [--no-prune] <provider/model>...
//
// Defaults to the global agent dir (~/.config/opencode/agent). Re-running syncs
// the managed set: it (re)writes grunt-<slug>.md + drill-<slug>.md for each
// listed model, and prunes previously generated grunt-/drill- (and legacy
// worker-) files carrying our marker that are no longer in the list.
// Hand-authored agents are never touched.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { agentMarkdown, GENERATED_MARKER_DETECT } from "../src/workers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const PROMPTS = {
  grunt: path.join(PACKAGE_ROOT, "prompts", "grunt.md"),
  drill: path.join(PACKAGE_ROOT, "prompts", "drill.md"),
};
const ROLES = ["grunt", "drill"];

function parseArgs(argv) {
  const models = [];
  let dir = path.join(os.homedir(), ".config", "opencode", "agent");
  let prune = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") dir = argv[++i];
    else if (a === "--no-prune") prune = false;
    else if (a.startsWith("--")) {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    } else models.push(a);
  }
  return { models, dir, prune };
}

function main() {
  const { models, dir, prune } = parseArgs(process.argv.slice(2));
  if (models.length === 0) {
    console.error(
      "No models given. Usage: squad-draft.mjs [--dir <d>] [--no-prune] <provider/model>...",
    );
    process.exit(2);
  }

  const body = Object.fromEntries(
    ROLES.map((r) => [r, fs.readFileSync(PROMPTS[r], "utf8")]),
  );
  fs.mkdirSync(dir, { recursive: true });

  const written = [];
  const wanted = new Set();
  for (const id of models) {
    for (const role of ROLES) {
      const { slug, filename, content } = agentMarkdown(role, id, body[role]);
      wanted.add(slug);
      fs.writeFileSync(path.join(dir, filename), content);
      written.push({ id, filename });
    }
  }

  // Prune our own previously-generated grunts/drills (and legacy worker-) no
  // longer requested. Only files carrying our marker prefix are touched.
  const pruned = [];
  if (prune) {
    for (const f of fs.readdirSync(dir)) {
      if (!/^(?:grunt|drill|worker)-.*\.md$/.test(f)) continue;
      if (wanted.has(f.replace(/\.md$/, ""))) continue;
      const full = path.join(dir, f);
      let txt = "";
      try {
        txt = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      if (txt.includes(GENERATED_MARKER_DETECT)) {
        fs.unlinkSync(full);
        pruned.push(f);
      }
    }
  }

  console.log(`Agent dir: ${dir}`);
  for (const w of written) console.log(`  wrote  ${w.filename}   (${w.id})`);
  for (const f of pruned) console.log(`  pruned ${f}`);
  console.log(
    `\n${models.length} model(s) -> ${written.length} agents (grunt + drill), ${pruned.length} pruned.`,
  );
  console.log(
    "Reload opencode (restart the TUI / start a new run) to pick up the new agents.",
  );
}

main();
