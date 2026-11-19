// The squad_patch decision and its report, plus the one-time import of a
// squad that older versions wrote as agent files.
//
// Since #85 the roster lives in squad.json (src/squad-store.js) and its
// agents are registered through the plugin API (src/squad-agents.js): an
// apply changes one file the plugin owns and never touches an agent file.
// What remains here is the part that was never about files: the deletion
// guard, and a report the orchestrator can act on.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFrontmatter } from "./frontmatter.js";
import { opencodeConfigDir } from "./paths.js";
import { buildRoster, diffRoster, parseAgentFile } from "./roster.js";
import { isGeneratedAgent } from "./workers.js";

const GENERATED_FILE_RE = /^(grunt|drill|worker)-.*\.md$/;

/** The global agent dir, where versions before #85 wrote the squad's files. */
export function defaultAgentDir() {
  return path.join(opencodeConfigDir(process.env, os.homedir()), "agent");
}

/**
 * Read a squad that an earlier version wrote as agent files, for the one-time
 * import into squad.json. Read-only: the files stay where they are, and the
 * plugin hides the agents they define once the roster no longer holds them
 * (src/squad-agents.js lateTransform).
 *
 * Only files carrying our generator marker count. A file whose model cannot be
 * read is reported, never silently dropped: an import that lost an agent
 * would look like a squad the user chose.
 *
 * @param {string} dir
 * @returns {{roster: Record<string, Record<string, any>>, problems: string[], files: string[],
 *   agents: Array<{id: string, system: string, modelId: string}>}}
 *   agents: each file as the host would load it (its prompt is the body,
 *   trimmed), so the plugin can tell whether the live agent at that id is
 *   this file or another agent the host loaded from elsewhere (#88)
 */
export function readLegacySquad(dir) {
  const parsed = [];
  /** @type {string[]} */
  const files = [];
  /** @type {Array<{id: string, system: string, modelId: string}>} */
  const agents = [];
  /** @type {string[]} */
  const problems = [];
  let names = [];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return { roster: buildRoster([]).roster, problems, files, agents };
  }
  for (const name of names) {
    const m = GENERATED_FILE_RE.exec(name);
    if (!m) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(dir, name), "utf8");
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e)?.code;
      if (code !== "ENOENT") problems.push(`${name}: cannot read (${code ?? "error"})`);
      continue;
    }
    if (!isGeneratedAgent(text)) continue;
    const { modelId, entry } = parseAgentFile(text);
    if (!modelId) {
      problems.push(`${name}: generated file with no readable model (damaged header)`);
      continue;
    }
    // Legacy `worker-` files predate the grunt/drill split: the executor.
    parsed.push({ role: m[1] === "worker" ? "grunt" : m[1], modelId, entry });
    files.push(name);
    agents.push({
      id: name.replace(/\.md$/, ""),
      system: readFrontmatter(text).body.replaceAll("\r\n", "\n").trim(),
      modelId,
    });
  }
  const { roster, conflicts } = buildRoster(parsed);
  return { roster, problems: [...problems, ...conflicts], files, agents };
}

/**
 * @typedef {{ok: true, diff: ReturnType<typeof diffRoster>}} PatchOk
 * @typedef {{ok: false, refusal: "remove" | "foreign", problems: string[], diff: ReturnType<typeof diffRoster>}} PatchRefused
 */

/**
 * Decide whether a roster may replace the current one.
 *
 * Two refusals, checked before anything is written:
 *   foreign — the roster asks for an agent id a hand-authored agent already
 *             holds; the user's agent wins and is not taken over;
 *   remove  — the apply would delete agents and `allowRemove` is not set.
 *
 * @param {{current: Record<string, any>, next: Record<string, any>, allowRemove?: boolean,
 *   foreign?: Array<{id: string, agent: string}>}} input
 *   foreign: hand-authored agents holding ids this roster wants
 * @returns {PatchOk | PatchRefused}
 */
export function planPatch({ current, next, allowRemove = false, foreign = [] }) {
  const diff = diffRoster(current, next);
  if (foreign.length) {
    return {
      ok: false,
      refusal: "foreign",
      problems: foreign.map((f) => `${f.agent}: agent id ${f.id} is a hand-authored agent`),
      diff,
    };
  }
  if (diff.removed.length && !allowRemove) {
    return { ok: false, refusal: "remove", problems: [...diff.removed], diff };
  }
  return { ok: true, diff };
}

/**
 * Human-readable report for squad_patch, including the variant echo, which is
 * the only place a mistyped reasoning level surfaces at all, since OpenCode
 * drops an unknown one silently.
 *
 * @param {PatchOk | PatchRefused} result
 * @param {{store: string, roster: Record<string, Record<string, any>>, notes?: string[]}} context
 * @returns {string}
 */
export function formatPatchReport(result, { store, roster, notes = [] }) {
  const lines = [`Squad roster: ${store}`];
  for (const n of notes) lines.push(`  note   ${n}`);

  if (!result.ok && result.refusal === "foreign") {
    lines.push(
      "",
      "REFUSED: the roster asks for an agent id that a hand-authored agent already holds:",
      ...result.problems.map((p) => `  - ${p}`),
      "",
      "Nothing was written. The existing agent belongs to the user: ask them to rename",
      "or remove it, or drop that entry from the roster.",
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

  const { diff } = result;
  lines.push(
    "",
    `+${diff.added.length} added, -${diff.removed.length} removed, ` +
      `~${diff.changed.length} changed, =${diff.unchanged.length} unchanged.`,
    ...diff.added.map((a) => `  + ${a}`),
    ...diff.changed.map((c) => `  ~ ${c}`),
    ...diff.removed.map((r) => `  - ${r}`),
  );
  const variants = [];
  for (const [key, role] of [
    ["grunts", "grunt"],
    ["drills", "drill"],
  ]) {
    for (const [id, entry] of Object.entries(roster[key] ?? {})) {
      if (entry?.variant) variants.push(`  ${role} ${id} -> ${entry.variant}`);
    }
  }
  if (variants.length) {
    lines.push(
      "",
      "Variants set — opencode IGNORES an unrecognized variant without erroring,",
      "so check each against that model's `reasoning_options` in models.dev:",
      ...variants,
    );
  }
  lines.push(
    "",
    "The plugin re-registered the squad's agents; the change applies to the next dispatch.",
    "No agent files are written: the roster above is the whole squad.",
  );
  return lines.join("\n");
}
