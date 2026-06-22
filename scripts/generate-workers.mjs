#!/usr/bin/env node
// Generate one hidden grunt (per-model worker) subagent per model id.
//
// Usage:
//   node generate-workers.mjs [--dir <agentDir>] [--no-prune] <provider/model>...
//
// Defaults to the global agent dir (~/.config/opencode/agent). Re-running syncs
// the managed set: it (re)writes the listed models and prunes previously
// generated grunt-*.md (and legacy worker-*.md) files carrying our marker that
// are no longer in the list. Hand-authored agents are never touched.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { slugForModel, workerAgentMarkdown, GENERATED_MARKER_PREFIX } from "../src/workers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const GRUNT_PROMPT = path.join(PACKAGE_ROOT, "prompts", "grunt.md");

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
      "No models given. Usage: generate-workers.mjs [--dir <d>] [--no-prune] <provider/model>...",
    );
    process.exit(2);
  }

  const promptBody = fs.readFileSync(GRUNT_PROMPT, "utf8");
  fs.mkdirSync(dir, { recursive: true });

  const written = [];
  const wantedSlugs = new Set();
  for (const id of models) {
    const { slug, filename, content } = workerAgentMarkdown(id, promptBody);
    wantedSlugs.add(slug);
    fs.writeFileSync(path.join(dir, filename), content);
    written.push({ id, filename });
  }

  // Prune our own previously-generated grunts that are no longer requested.
  // Match both the current `grunt-` prefix and the legacy `worker-` one, so the
  // worker->grunt rename migrates cleanly. Only files carrying our marker prefix
  // are touched — hand-authored agents are never removed.
  const pruned = [];
  if (prune) {
    for (const f of fs.readdirSync(dir)) {
      if (!/^(?:grunt|worker)-.*\.md$/.test(f)) continue;
      const slug = f.replace(/\.md$/, "");
      if (wantedSlugs.has(slug)) continue;
      const full = path.join(dir, f);
      let body = "";
      try {
        body = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      if (body.includes(GENERATED_MARKER_PREFIX)) {
        fs.unlinkSync(full);
        pruned.push(f);
      }
    }
  }

  console.log(`Agent dir: ${dir}`);
  for (const w of written) console.log(`  wrote  ${w.filename}   (${w.id})`);
  for (const f of pruned) console.log(`  pruned ${f}`);
  console.log(
    `\n${written.length} grunt(s) generated, ${pruned.length} pruned.`,
  );
  console.log(
    "Reload opencode (restart the TUI / start a new run) to pick up the new agents.",
  );
}

main();
