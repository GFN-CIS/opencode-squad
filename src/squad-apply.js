// Filesystem side of the squad roster: read it off disk, write one back.
// Backs the `squad_dump` / `squad_patch` plugin tools.
//
// Kept apart from src/roster.js so that module stays pure and directly
// testable, and apart from the tool definitions so the deletion guard and the
// report have exactly one implementation.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { opencodeConfigDir } from "./paths.js";
import { buildRoster, diffRoster, parseAgentFile, ROLE_KEYS } from "./roster.js";
import { agentMarkdown, GENERATED_MARKER_DETECT } from "./workers.js";

const GENERATED_FILE_RE = /^(grunt|drill|worker)-.*\.md$/;

/** The global agent dir opencode merges; the default target for the squad. */
export function defaultAgentDir() {
  return path.join(opencodeConfigDir(process.env, os.homedir()), "agent");
}

/**
 * Read the squad that currently exists, from the generated agent files
 * themselves — there is deliberately no stored manifest to consult, so there is
 * nothing that can desync from what opencode will actually load.
 *
 * Only files carrying our marker count: a hand-authored `grunt-something.md`
 * belongs to somebody else and is neither dumped nor pruned.
 *
 * @param {string} dir
 * @returns {{roster: Record<string, Record<string, any>>, conflicts: string[], filesByAgent: Map<string, string>}}
 */
export function readSquad(dir) {
  const files = [];
  /** @type {Map<string, string>} */
  const filesByAgent = new Map();
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // No agent dir yet is an empty squad, not an error — also the first-run path.
    return { roster: buildRoster([]).roster, conflicts: [], filesByAgent };
  }
  for (const name of names) {
    const m = GENERATED_FILE_RE.exec(name);
    if (!m) continue;
    let txt;
    try {
      txt = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    if (!txt.includes(GENERATED_MARKER_DETECT)) continue;
    const { modelId, entry } = parseAgentFile(txt);
    if (!modelId) continue;
    // Legacy `worker-` files predate the grunt/drill split; treat them as the
    // executor so an old squad still round-trips instead of vanishing.
    const role = m[1] === "worker" ? "grunt" : m[1];
    files.push({ role, modelId, entry });
    filesByAgent.set(`${role} ${modelId}`, name);
  }
  const { roster, conflicts } = buildRoster(files);
  return { roster, conflicts, filesByAgent };
}

/**
 * Write a roster to the agent dir.
 *
 * Returns `{ok: false, ...}` rather than throwing when the apply would delete
 * agents and `allowRemove` is not set — the refusal is an ordinary outcome the
 * caller reports, not an exception. The refusal is total: not even the agents
 * that would have been added get written, so a rejected apply leaves the squad
 * exactly as it was.
 *
 * `describe(role, modelId)` supplies each agent's description (see
 * describeAgent); without it the role's generic line is written.
 *
 * @param {{roster: Record<string, Record<string, any>>, dir: string, allowRemove?: boolean,
 *   describe?: (role: "grunt"|"drill", modelId: string) => string|undefined}} input
 * @returns {{ok: boolean, diff: {added:string[],removed:string[],changed:string[],unchanged:string[]}, written: Array<{role:string,id:string,variant?:string,filename:string}>, pruned: string[], refreshed?: string[], conflicts: string[], dir: string}}
 */
export function applySquad({ roster, dir, allowRemove = false, describe }) {
  const { roster: current, conflicts, filesByAgent } = readSquad(dir);
  const diff = diffRoster(current, roster);

  if (diff.removed.length > 0 && !allowRemove) {
    return { ok: false, diff, written: [], pruned: [], conflicts, dir };
  }

  // The bundled prompts are deliberately NOT read here: an agent file carries a
  // fenced placeholder and the plugin injects the current role prompt at
  // request time (src/prompt-inject.js), so this writes only frontmatter and
  // the roster's own `notes`.
  fs.mkdirSync(dir, { recursive: true });

  const written = [];
  // Descriptions follow model_data.json, not the roster, so the roster diff
  // cannot see them change; report them separately or an `info` edit
  // re-applied reads as "=14 unchanged" while 14 files changed.
  const refreshed = [];
  for (const [key, role] of Object.entries(ROLE_KEYS)) {
    for (const [modelId, entry] of Object.entries(roster?.[key] ?? {})) {
      const { filename, content } = agentMarkdown(role, modelId, {
        ...entry,
        description: describe?.(role, modelId),
      });
      const file = path.join(dir, filename);
      if (fs.existsSync(file)) {
        const before = descriptionLine(fs.readFileSync(file, "utf8"));
        const after = descriptionLine(content);
        if (before !== after) refreshed.push(`${role} ${modelId}: ${after}`);
      }
      writeAtomic(file, content);
      written.push({ role, id: modelId, variant: entry?.variant, filename });
    }
  }

  const pruned = [];
  for (const agent of diff.removed) {
    const f = filesByAgent.get(agent);
    if (!f) continue;
    fs.unlinkSync(path.join(dir, f));
    pruned.push(f);
  }

  return { ok: true, diff, written, pruned, refreshed, conflicts, dir };
}

/**
 * Bring the existing squad's descriptions in line with model_data.json — run at
 * plugin start. opencode reloads agent files on change (an `agent.updated`
 * event, seconds later), so an edited `info` or plan reaches the orchestrator
 * without anyone re-drafting the squad.
 *
 * Re-renders each generated file from its own roster entry, so variant, steps
 * and notes survive; writes only files whose content actually changes, since
 * every write makes opencode reload — and one service process runs this for
 * every project it hosts. Files under a legacy name are left for squad_patch,
 * which migrates them.
 *
 * @param {{dir: string, describe: (role: "grunt"|"drill", modelId: string) => string|undefined}} input
 * @returns {string[]}  filenames rewritten
 */
export function syncDescriptions({ dir, describe }) {
  const { roster, filesByAgent } = readSquad(dir);
  const rewritten = [];
  for (const [key, role] of Object.entries(ROLE_KEYS)) {
    for (const [modelId, entry] of Object.entries(roster[key] ?? {})) {
      const { filename, content } = agentMarkdown(role, modelId, {
        ...entry,
        description: describe(role, modelId),
      });
      if (filesByAgent.get(`${role} ${modelId}`) !== filename) continue;
      const file = path.join(dir, filename);
      let current;
      try {
        current = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (current === content) continue;
      writeAtomic(file, content);
      rewritten.push(filename);
    }
  }
  return rewritten;
}

/** The frontmatter `description:` value as written (quoted or not). */
function descriptionLine(text) {
  return /^description: (.*)$/m.exec(text)?.[1] ?? "";
}

// A watcher (opencode's) sees either the old file or the new one, never half.
function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/**
 * Human-readable report for an apply — including the variant echo, which is the
 * only place a mistyped reasoning level surfaces at all, since opencode drops an
 * unknown one silently.
 *
 * @param {ReturnType<typeof applySquad>} result
 * @returns {string}
 */
export function formatApplyReport(result) {
  const lines = [`Agent dir: ${result.dir}`];
  for (const c of result.conflicts) lines.push(`  note   ${c}`);

  if (!result.ok) {
    lines.push(
      "",
      `REFUSED: applying this roster would DELETE ${result.diff.removed.length} agent(s):`,
      ...result.diff.removed.map((a) => `  - ${a}`),
      "",
      "Nothing was written. If the user asked for these deletions, retry with allow_remove.",
      "If you meant to ADD or RETUNE an agent, you are working from the wrong roster —",
      "dump the current squad and edit THAT, rather than composing a new one.",
    );
    return lines.join("\n");
  }

  for (const w of result.written) {
    lines.push(`  wrote  ${w.filename}   (${w.id}${w.variant ? `, variant: ${w.variant}` : ""})`);
  }
  for (const f of result.pruned) lines.push(`  pruned ${f}`);
  lines.push(
    "",
    `+${result.diff.added.length} added, -${result.diff.removed.length} removed, ` +
      `~${result.diff.changed.length} changed, =${result.diff.unchanged.length} unchanged.`,
    ...result.diff.added.map((a) => `  + ${a}`),
    ...result.diff.changed.map((c) => `  ~ ${c}`),
    ...result.diff.removed.map((r) => `  - ${r}`),
  );
  if (result.refreshed?.length) {
    lines.push(
      "",
      `Descriptions refreshed from model_data.json (${result.refreshed.length}):`,
      ...result.refreshed.map((r) => `  ~ ${r}`),
    );
  }

  const variants = result.written.filter((w) => w.variant);
  if (variants.length > 0) {
    lines.push(
      "",
      "Variants written — opencode IGNORES an unrecognized variant without erroring,",
      "so check each against that model's `reasoning_options` in models.dev:",
      ...variants.map((w) => `  ${w.role} ${w.id} -> ${w.variant}`),
    );
  }
  lines.push(
    "",
    "OpenCode reloads changed agent files automatically; no restart is needed.",
    "Role prompt bodies do NOT need this: the plugin refreshes them from the bundled",
    "prompts/<role>.md on every request.",
  );
  return lines.join("\n");
}
