// Filesystem side of the squad roster: read it off disk, write one back.
// Backs the `squad_dump` / `squad_patch` plugin tools.
//
// Kept apart from src/roster.js so that module stays pure and directly
// testable, and apart from the tool definitions so the deletion guard and the
// report have exactly one implementation.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeFileAtomic } from "./fs-atomic.js";
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
 * `filesByAgent` lists EVERY generated file that claims an agent, in directory
 * order: a legacy `worker-` file and its `grunt-` successor, or two ids that
 * slug to near-identical names, all have to go when that agent is removed.
 *
 * @param {string} dir
 * @returns {{roster: Record<string, Record<string, any>>, conflicts: string[], filesByAgent: Map<string, string[]>}}
 */
export function readSquad(dir) {
  const files = [];
  /** @type {Map<string, string[]>} */
  const filesByAgent = new Map();
  let names = [];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    // No agent dir yet is an empty squad, not an error — also the first-run path.
    return { roster: buildRoster([]).roster, conflicts: [], filesByAgent };
  }
  /** @type {string[]} */
  const unreadable = [];
  for (const name of names) {
    const m = GENERATED_FILE_RE.exec(name);
    if (!m) continue;
    const read = readText(path.join(dir, name));
    if (read.state === "error") {
      unreadable.push(`${name}: cannot read (${read.code})`);
      continue;
    }
    if (read.state === "missing" || !isGenerated(read.text)) continue;
    const { modelId, entry } = parseAgentFile(read.text);
    if (!modelId) {
      unreadable.push(
        `${name}: generated file with no readable model (damaged header). It is left as is and blocks the model_data.json refresh: ask the user to repair or delete it`,
      );
      continue;
    }
    // Legacy `worker-` files predate the grunt/drill split; treat them as the
    // executor so an old squad still round-trips instead of vanishing.
    const role = m[1] === "worker" ? "grunt" : m[1];
    files.push({ role, modelId, entry });
    const agent = `${role} ${modelId}`;
    filesByAgent.set(agent, [...(filesByAgent.get(agent) ?? []), name]);
  }
  const { roster, conflicts } = buildRoster(files);
  return { roster, conflicts: [...conflicts, ...unreadable], filesByAgent };
}

/**
 * A missing file and one that cannot be read are different answers: only the
 * first means there is nothing to protect.
 *
 * @param {string} file
 * @returns {{state: "ok", text: string} | {state: "missing"} | {state: "error", code: string}}
 */
function readText(file) {
  try {
    return { state: "ok", text: fs.readFileSync(file, "utf8") };
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    if (err?.code === "ENOENT") return { state: "missing" };
    return { state: "error", code: err?.code ?? err?.name ?? "error" };
  }
}

/** @param {string} text */
const isGenerated = (text) => text.includes(GENERATED_MARKER_DETECT);

/**
 * @typedef {{role: string, id: string, variant?: string, filename: string, unchanged?: boolean}} WrittenAgent
 * @typedef {{ok: true, diff: ReturnType<typeof diffRoster>, written: WrittenAgent[], pruned: string[],
 *   migrated: string[], refreshed: string[], conflicts: string[], dir: string}} ApplyDone
 * @typedef {{ok: false, refusal: "remove" | "collision" | "unreadable", problems: string[],
 *   diff: ReturnType<typeof diffRoster>, written: [], pruned: [], conflicts: string[], dir: string}} ApplyRefused
 */

/**
 * Write a roster to the agent dir.
 *
 * Returns `{ok: false, ...}` rather than throwing when the apply is refused —
 * the refusal is an ordinary outcome the caller reports, not an exception —
 * and every check runs before the first write, so a refused apply leaves the
 * squad exactly as it was. Three refusals:
 *
 *   remove     — the apply would delete agents and `allowRemove` is not set;
 *   collision  — two roster agents map to one filename (`p/model-1` and
 *                `p/model.1` both slug to `grunt-p-model-1.md`), or the target
 *                file exists and is not ours (hand-authored);
 *   unreadable — a target file exists but cannot be read, so whether it is
 *                ours cannot be established.
 *
 * Another generated file still claiming a kept agent is handled by name. A
 * legacy `worker-` file is migrated: deleted once the agent's `grunt-` file is
 * written, so the agent lives in one file and a later removal removes it
 * completely. Any other one (a hand copy that kept our marker) is a separate
 * agent to OpenCode, so deleting it is a removal like any other: refused
 * without `allowRemove`, pruned with it.
 *
 * On success: a file whose text is already identical is not rewritten (every
 * write makes opencode reload), and a file pruned for a removed agent is never
 * one just written for a kept agent.
 *
 * `describe(role, modelId)` supplies each agent's description (see
 * describeAgent); without it the role's generic line is written.
 *
 * @param {{roster: Record<string, Record<string, any>>, dir: string, allowRemove?: boolean,
 *   describe?: (role: "grunt"|"drill", modelId: string) => string|undefined}} input
 * @returns {ApplyDone | ApplyRefused}
 */
export function applySquad({ roster, dir, allowRemove = false, describe }) {
  const { roster: current, conflicts, filesByAgent } = readSquad(dir);
  const diff = diffRoster(current, roster);
  /** @param {ApplyRefused["refusal"]} refusal @param {string[]} problems @returns {ApplyRefused} */
  const refuse = (refusal, problems) => ({
    ok: false,
    refusal,
    problems,
    diff,
    written: [],
    pruned: [],
    conflicts,
    dir,
  });

  // The bundled prompts are deliberately NOT read here: an agent file carries a
  // fenced placeholder and the plugin injects the current role prompt at
  // request time (src/prompt-inject.js), so this writes only frontmatter and
  // the roster's own `notes`.
  const plan = [];
  /** @type {Map<string, string>} filename -> the agent it is planned for */
  const byFile = new Map();
  const problems = [];
  /** @type {string[]} */
  const unreadable = [];
  for (const [key, role] of Object.entries(ROLE_KEYS)) {
    for (const [modelId, entry] of Object.entries(roster?.[key] ?? {})) {
      const { filename, content } = agentMarkdown(role, modelId, {
        ...entry,
        description: describe?.(role, modelId),
      });
      const agent = `${role} ${modelId}`;
      const other = byFile.get(filename);
      if (other) {
        problems.push(`${other} and ${agent} would both be written to ${filename}`);
        continue;
      }
      byFile.set(filename, agent);
      const read = readText(path.join(dir, filename));
      if (read.state === "error") {
        unreadable.push(`${path.join(dir, filename)}: ${read.code} (${agent} targets it)`);
        continue;
      }
      const existing = read.state === "ok" ? read.text : null;
      if (existing !== null && !isGenerated(existing)) {
        problems.push(
          `${filename} exists and was not generated by this plugin (${agent} targets it)`,
        );
        continue;
      }
      plan.push({ role, modelId, entry, filename, content, existing });
    }
  }
  if (unreadable.length) return refuse("unreadable", unreadable);
  if (problems.length) return refuse("collision", problems);

  /** @type {string[]} */
  const migrate = [];
  /** @type {Array<{file: string, agent: string}>} */
  const duplicates = [];
  for (const [agent, files] of filesByAgent) {
    if (diff.removed.includes(agent)) continue;
    for (const f of files) {
      if (byFile.has(f)) continue;
      if (f.startsWith("worker-")) migrate.push(f);
      else duplicates.push({ file: f, agent });
    }
  }
  if ((diff.removed.length > 0 || duplicates.length > 0) && !allowRemove) {
    return refuse("remove", [
      ...diff.removed,
      ...duplicates.map((d) => `${d.file} (a second file for ${d.agent})`),
    ]);
  }

  fs.mkdirSync(dir, { recursive: true });

  /** @type {WrittenAgent[]} */
  const written = [];
  // Descriptions follow model_data.json, not the roster, so the roster diff
  // cannot see them change; report them separately or an `info` edit
  // re-applied reads as "=14 unchanged" while 14 files changed.
  const refreshed = [];
  for (const { role, modelId, entry, filename, content, existing } of plan) {
    const unchanged = existing === content;
    if (existing !== null && !unchanged) {
      const before = descriptionLine(existing);
      const after = descriptionLine(content);
      if (before !== after) refreshed.push(`${role} ${modelId}: ${after}`);
    }
    if (!unchanged) writeFileAtomic(path.join(dir, filename), content);
    written.push({
      role,
      id: modelId,
      variant: entry?.variant,
      filename,
      ...(unchanged ? { unchanged: true } : {}),
    });
  }

  const pruned = [];
  for (const agent of diff.removed) {
    for (const f of filesByAgent.get(agent) ?? []) {
      if (byFile.has(f)) continue; // now holds a kept agent
      fs.unlinkSync(path.join(dir, f));
      pruned.push(f);
    }
  }
  for (const { file } of duplicates) {
    fs.unlinkSync(path.join(dir, file));
    pruned.push(file);
  }
  const migrated = [];
  for (const f of migrate) {
    fs.unlinkSync(path.join(dir, f));
    migrated.push(f);
  }

  return { ok: true, diff, written, pruned, migrated, refreshed, conflicts, dir };
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
      if (!filesByAgent.get(`${role} ${modelId}`)?.includes(filename)) continue;
      const file = path.join(dir, filename);
      let current;
      try {
        current = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (current === content) continue;
      writeFileAtomic(file, content);
      rewritten.push(filename);
    }
  }
  return rewritten;
}

/** The frontmatter `description:` value as written (quoted or not). */
/** @param {string} text */
function descriptionLine(text) {
  return /^description: (.*)$/m.exec(text)?.[1] ?? "";
}

/**
 * Human-readable report for an apply — including the variant echo, which is the
 * only place a mistyped reasoning level surfaces at all, since opencode drops an
 * unknown one silently.
 *
 * @param {ApplyDone | ApplyRefused} result
 * @returns {string}
 */
export function formatApplyReport(result) {
  const lines = [`Agent dir: ${result.dir}`];
  for (const c of result.conflicts) lines.push(`  note   ${c}`);

  if (!result.ok && result.refusal === "unreadable") {
    lines.push(
      "",
      "REFUSED: an agent file this roster would replace cannot be read, so it is",
      "unknown whether this plugin wrote it:",
      ...result.problems.map((p) => `  - ${p}`),
      "",
      "Nothing was written. The file may be the user's own agent: tell the user and",
      "let them fix its permissions or move it. Do not retry until they have.",
    );
    return lines.join("\n");
  }
  if (!result.ok && result.refusal === "collision") {
    lines.push(
      "",
      "REFUSED: the roster cannot be written without clobbering an agent file:",
      ...result.problems.map((p) => `  - ${p}`),
      "",
      "Nothing was written. Two model ids that differ only in punctuation share a",
      "filename — keep one of them. A file that is not ours belongs to the user: ask",
      "before touching it.",
    );
    return lines.join("\n");
  }
  if (!result.ok) {
    lines.push(
      "",
      `REFUSED: applying this roster would DELETE ${result.problems.length} agent(s):`,
      ...result.problems.map((a) => `  - ${a}`),
      "",
      "Nothing was written. If the user asked for these deletions, retry with allow_remove.",
      "If you meant to ADD or RETUNE an agent, you are working from the wrong roster —",
      "dump the current squad and edit THAT, rather than composing a new one.",
    );
    return lines.join("\n");
  }

  for (const w of result.written) {
    lines.push(
      `  ${w.unchanged ? "same " : "wrote"}  ${w.filename}   (${w.id}${w.variant ? `, variant: ${w.variant}` : ""})`,
    );
  }
  for (const f of result.pruned) lines.push(`  pruned ${f}`);
  for (const f of result.migrated) lines.push(`  migrated away from ${f}`);
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
