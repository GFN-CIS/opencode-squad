// Filesystem side of the squad roster: read it off disk, write one back.
// Backs the `squad_dump` / `squad_patch` plugin tools.
//
// Kept apart from src/roster.js so that module stays pure and directly
// testable, and apart from the tool definitions so the removal guard and the
// report have exactly one implementation.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ALL_ROLES, buildRoster, diffRoster, parseAgentFrontmatter, rolesOf } from "./roster.js";
import { agentMarkdown, GENERATED_MARKER_DETECT } from "./workers.js";

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
 * belongs to somebody else and is neither exported nor pruned.
 *
 * @param {string} dir
 * @returns {{roster: {version:number, models: Array<{id:string, variant?:string, roles?:string[]}>}, conflicts: string[], filesByModel: Map<string, Map<string, string>>}}
 */
export function readSquad(dir) {
  const entries = [];
  const filesByModel = new Map();
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    // No agent dir yet is an empty squad, not an error — this is also the
    // first-run path.
    return { roster: buildRoster([]).roster, conflicts: [], filesByModel };
  }
  for (const f of files) {
    const m = GENERATED_FILE_RE.exec(f);
    if (!m) continue;
    let txt;
    try {
      txt = fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    if (!txt.includes(GENERATED_MARKER_DETECT)) continue;
    const { modelId, variant } = parseAgentFrontmatter(txt);
    if (!modelId) continue;
    // Legacy `worker-` files predate the grunt/drill split; treat them as the
    // executor so an old squad still round-trips instead of vanishing.
    const role = m[1] === "worker" ? "grunt" : m[1];
    entries.push({ modelId, role, variant });
    if (!filesByModel.has(modelId)) filesByModel.set(modelId, new Map());
    filesByModel.get(modelId).set(role, f);
  }
  const { roster, conflicts } = buildRoster(entries);
  return { roster, conflicts, filesByModel };
}

/**
 * Write a roster to the agent dir.
 *
 * Returns `{ok: false, ...}` rather than throwing when the apply would remove
 * models and `allowRemove` is not set — the refusal is an ordinary outcome the
 * caller reports, not an exception.
 *
 * @param {{roster: {models: Array<{id:string, variant?:string}>}, dir: string, allowRemove?: boolean, packageRoot: string}} input
 * @returns {{ok: boolean, diff: {added:string[],removed:string[],changed:string[],unchanged:string[],removedRoles:Array<{id:string,role:string}>}, written: Array<{id:string,role:string,variant?:string,filename:string}>, pruned: string[], conflicts: string[], dir: string, wouldDelete?: number}}
 */
export function applySquad({ roster, dir, allowRemove = false, packageRoot }) {
  const { roster: current, conflicts, filesByModel } = readSquad(dir);
  const diff = diffRoster(current, roster);

  // Every generated agent that would disappear counts, whether it goes because
  // its model left the roster or because the entry was narrowed to one role.
  // "Nothing is deleted without an explicit opt-in" is a simpler invariant to
  // trust than one that protects only whole models.
  if ((diff.removed.length > 0 || diff.removedRoles.length > 0) && !allowRemove) {
    // Counted in FILES, not models: a model leaving takes however many role
    // files it actually has with it. The caller is deciding whether to lose
    // agents, so that is the number to put in front of them.
    const wouldDelete =
      diff.removed.reduce((n, id) => n + (filesByModel.get(id)?.size ?? 0), 0) +
      diff.removedRoles.filter(({ id, role }) => filesByModel.get(id)?.has(role)).length;
    return { ok: false, diff, written: [], pruned: [], conflicts, dir, wouldDelete };
  }

  const body = Object.fromEntries(
    ALL_ROLES.map((r) => [
      r,
      fs.readFileSync(path.join(packageRoot, "prompts", `${r}.md`), "utf8"),
    ]),
  );
  fs.mkdirSync(dir, { recursive: true });

  const written = [];
  for (const entry of roster.models) {
    for (const role of rolesOf(entry.roles)) {
      const { filename, content } = agentMarkdown(role, entry.id, body[role], {
        variant: entry.variant,
      });
      fs.writeFileSync(path.join(dir, filename), content);
      written.push({ id: entry.id, role, variant: entry.variant, filename });
    }
  }

  const pruned = [];
  for (const id of diff.removed) {
    for (const f of (filesByModel.get(id) ?? new Map()).values()) {
      fs.unlinkSync(path.join(dir, f));
      pruned.push(f);
    }
  }
  for (const { id, role } of diff.removedRoles) {
    const f = filesByModel.get(id)?.get(role);
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
    const roleDrops = result.diff.removedRoles ?? [];
    lines.push(
      "",
      `REFUSED: applying this roster would DELETE ${result.wouldDelete} agent file(s).`,
      ...(result.diff.removed.length
        ? [
            "",
            `models leaving the squad (${result.diff.removed.length}):`,
            ...result.diff.removed.map((id) => `  - ${id}`),
          ]
        : []),
      ...(roleDrops.length
        ? [
            "",
            `roles dropped from models that stay (${roleDrops.length}):`,
            ...roleDrops.map((r) => `  - ${r.role} for ${r.id}`),
          ]
        : []),
      "",
      "Nothing was written. If the user asked for these removals, retry with allow_remove.",
      "If you meant to ADD or RETUNE a model, you are working from the wrong roster —",
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
    const seen = new Map();
    for (const w of variants) seen.set(w.id, w.variant);
    lines.push(
      "",
      "Variants written — opencode IGNORES an unrecognized variant without erroring,",
      "so check each against that model's `reasoning_options` in models.dev:",
      ...[...seen].map(([id, v]) => `  ${id} -> ${v}`),
    );
  }
  lines.push("", "Reload opencode (restart the TUI / start a new run) to pick up the new agents.");
  return lines.join("\n");
}
