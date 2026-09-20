// Filesystem side of the squad roster: read it off disk, write one back.
// Backs the `squad_dump` / `squad_patch` plugin tools.
//
// Kept apart from src/roster.js so that module stays pure and directly
// testable, and apart from the tool definitions so the deletion guard and the
// report have exactly one implementation.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildRoster, diffRoster, parseAgentFile, ROLE_KEYS } from "./roster.js";
import { agentMarkdown, defaultDescriptions, GENERATED_MARKER_DETECT } from "./workers.js";

const GENERATED_FILE_RE = /^(grunt|drill|worker)-.*\.md$/;

/** The global agent dir opencode merges; the default target for the squad. */
export function defaultAgentDir() {
  return path.join(os.homedir(), ".config", "opencode", "agent");
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
  const { roster, conflicts } = buildRoster(files, defaultDescriptions());
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
 * @param {{roster: Record<string, Record<string, any>>, dir: string, allowRemove?: boolean, packageRoot: string}} input
 * @returns {{ok: boolean, diff: {added:string[],removed:string[],changed:string[],unchanged:string[]}, written: Array<{role:string,id:string,variant?:string,filename:string}>, pruned: string[], conflicts: string[], dir: string}}
 */
export function applySquad({ roster, dir, allowRemove = false, packageRoot }) {
  const { roster: current, conflicts, filesByAgent } = readSquad(dir);
  const diff = diffRoster(current, roster);

  if (diff.removed.length > 0 && !allowRemove) {
    return { ok: false, diff, written: [], pruned: [], conflicts, dir };
  }

  const body = Object.fromEntries(
    Object.values(ROLE_KEYS).map((r) => [
      r,
      fs.readFileSync(path.join(packageRoot, "prompts", `${r}.md`), "utf8"),
    ]),
  );
  fs.mkdirSync(dir, { recursive: true });

  const written = [];
  for (const [key, role] of Object.entries(ROLE_KEYS)) {
    for (const [modelId, entry] of Object.entries(roster?.[key] ?? {})) {
      const { filename, content } = agentMarkdown(role, modelId, body[role], entry ?? {});
      fs.writeFileSync(path.join(dir, filename), content);
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

  return { ok: true, diff, written, pruned, conflicts, dir };
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
    "Reload opencode (restart the TUI / start a new run) to pick up the new agents.",
    "Role prompt bodies do NOT need this: the plugin refreshes them from the bundled",
    "prompts/<role>.md on every request. The reload is for the frontmatter written here.",
  );
  return lines.join("\n");
}
