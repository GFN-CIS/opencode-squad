// The leading YAML frontmatter block of a Markdown file — agent files and
// SKILL.md alike — parsed with a real YAML parser, so quoting, comments and
// block scalars mean here what they mean to OpenCode, which reads the same
// files. Each reader decides for itself what a malformed header means.

import { parse } from "yaml";

// `---` on the first line, then everything up to the next line that is `---`.
// LF or CRLF; an empty header is allowed.
const FRONTMATTER_RE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/**
 * @param {string} text  a whole Markdown file
 * @returns {{state: "none", body: string}
 *   | {state: "invalid", body: string, reason: string}
 *   | {state: "ok", fields: Record<string, unknown>, body: string}}
 *   `none`: no leading block (body is the whole text); `invalid`: a block
 *   that is not a YAML mapping; `ok`: its fields. `body` is the text after
 *   the block.
 */
export function readFrontmatter(text) {
  const src = String(text);
  const m = FRONTMATTER_RE.exec(src);
  if (!m) return { state: "none", body: src };
  const body = src.slice(m[0].length);
  let fields;
  try {
    fields = parse(m[1] ?? "") ?? {};
  } catch (e) {
    return { state: "invalid", body, reason: e instanceof Error ? e.name : "YAMLError" };
  }
  if (typeof fields !== "object" || Array.isArray(fields)) {
    return { state: "invalid", body, reason: "not a mapping" };
  }
  return { state: "ok", fields: /** @type {Record<string, unknown>} */ (fields), body };
}
