/**
 * Bundled skills for OpenCode 2 (shared verbatim with opencode-time-logger).
 *
 * OpenCode 1 let a plugin append a directory to `config.skills.paths`; OpenCode
 * 2 has no config hook, so the plugin reads each `<dir>/<skill>/SKILL.md`
 * itself and registers it through `ctx.skill.transform`. The registered entry
 * mirrors what OpenCode 2 builds for a discovered skill: frontmatter `name` and
 * `description`, the absolute file path, and the body without frontmatter as
 * `content`.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Split a SKILL.md into its frontmatter fields and body. Handles the subset of
 * YAML that skill frontmatter uses: `key: value`, single- or double-quoted
 * values, and `>` / `|` block scalars. Anything fancier is read as plain text.
 *
 * Pure function — no I/O.
 *
 * @param {string} text
 * @returns {{ fields: Record<string, string>, body: string }}
 */
export function parseSkillFile(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { fields: {}, body: text };

  /** @type {Record<string, string>} */
  const fields = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const [, key, raw] = kv;
    let value = raw.trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const block = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        block.push(lines[++i].trim());
      }
      value = block.join(value.startsWith(">") ? " " : "\n");
    } else if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1).replace(/''/g, "'");
    }
    fields[key] = value;
  }
  return { fields, body: text.slice(match[0].length) };
}

/**
 * Read every `<dir>/<name>/SKILL.md` under the given directories. A skill
 * without a frontmatter name falls back to its folder name; unreadable or
 * missing directories are skipped.
 *
 * @param {string[]} dirs absolute directories holding one folder per skill
 * @returns {Array<{ id: string, name: string, description?: string, path: string, content: string }>}
 */
export function loadSkills(dirs) {
  const skills = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(dir, entry.name, "SKILL.md");
      let text;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const { fields, body } = parseSkillFile(text);
      const name = fields.name || entry.name;
      skills.push({
        id: name,
        name,
        ...(fields.description ? { description: fields.description } : {}),
        path: file,
        content: body,
      });
    }
  }
  return skills;
}
