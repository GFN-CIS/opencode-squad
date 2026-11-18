/**
 * Bundled skills for OpenCode 2 (derived from opencode-time-logger's loader;
 * the frontmatter is now read by src/frontmatter.js).
 *
 * OpenCode 2 has no config hook, so the plugin reads each `<dir>/<skill>/SKILL.md`
 * itself and registers it through `ctx.skill.transform`. The registered entry
 * mirrors what OpenCode 2 builds for a discovered skill: frontmatter `name` and
 * `description`, the absolute file path, and the body without frontmatter as
 * `content`.
 */

import fs from "node:fs";
import path from "node:path";

import { readFrontmatter } from "../frontmatter.js";

/**
 * Split a SKILL.md into its frontmatter fields and body. Fields are read with
 * the YAML parser (src/frontmatter.js); only string values are kept, since the
 * skill entry carries text. A file without frontmatter is all body; a header
 * that is not valid YAML gives no fields (the folder name stands in for the
 * name) and the text after it as the body.
 *
 * Pure function — no I/O.
 *
 * @param {string} text
 * @returns {{ fields: Record<string, string>, body: string }}
 */
export function parseSkillFile(text) {
  const fm = readFrontmatter(text);
  if (fm.state !== "ok") return { fields: {}, body: fm.body };
  /** @type {Record<string, string>} */
  const fields = {};
  for (const [key, value] of Object.entries(fm.fields)) {
    if (typeof value === "string") fields[key] = value;
  }
  return { fields, body: fm.body };
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
