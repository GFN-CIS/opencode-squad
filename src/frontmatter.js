// The leading YAML frontmatter block of a Markdown file — agent files and
// SKILL.md alike — parsed with a real YAML parser, so quoting, comments and
// block scalars mean here what they mean to OpenCode, which reads the same
// files. Each reader decides for itself what a malformed header means.

import { parse } from "yaml";

// `---` on the first line, then everything up to the next line that is `---`.
// LF or CRLF; an empty header is allowed.
const FRONTMATTER_RE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;
// The opening line alone: a block was started.
const OPENING_RE = /^---[ \t]*(?:\r?\n|$)/;

/**
 * @param {string} text  a whole Markdown file (a leading BOM is ignored)
 * @returns {{state: "none", body: string}
 *   | {state: "incomplete", header: string, body: string}
 *   | {state: "invalid", header: string, body: string, reason: string}
 *   | {state: "ok", fields: Record<string, unknown>, body: string}}
 *   `none`: no leading block (body is the whole text); `incomplete`: a
 *   block is opened but never closed — a truncated file, whose fields are
 *   unknown rather than absent (`header` is everything after the opening
 *   line, `body` the whole text); `invalid`: a block that is not a YAML
 *   mapping (`header` is its raw text); `ok`: its fields. Otherwise `body` is
 *   the text after the block.
 */
export function readFrontmatter(text) {
  const src = String(text).replace(/^\uFEFF/, "");
  const m = FRONTMATTER_RE.exec(src);
  if (!m) {
    const open = OPENING_RE.exec(src);
    if (open) return { state: "incomplete", header: src.slice(open[0].length), body: src };
    return { state: "none", body: src };
  }
  const body = src.slice(m[0].length);
  const header = m[1] ?? "";
  let fields;
  try {
    fields = parse(header) ?? {};
  } catch (e) {
    return { state: "invalid", header, body, reason: e instanceof Error ? e.name : "YAMLError" };
  }
  if (typeof fields !== "object" || Array.isArray(fields)) {
    return { state: "invalid", header, body, reason: "not a mapping" };
  }
  return { state: "ok", fields: /** @type {Record<string, unknown>} */ (fields), body };
}

/**
 * Top-level `key: value` lines of a header that is not valid YAML, read the
 * way this plugin's own files from before 0.4.1 need: those wrote
 * `description:` unquoted, so an owner rule containing ": " made the whole
 * header invalid YAML while every other line stayed a plain scalar. Values are
 * trimmed, with one pair of surrounding quotes removed; indented and comment
 * lines are skipped.
 *
 * @param {string} header  raw header text (readFrontmatter's `header`)
 * @returns {Record<string, string>}
 */
export function legacyHeaderFields(header) {
  /** @type {Record<string, string>} */
  const fields = {};
  for (const line of header.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*):[ \t]*(\S.*?)\s*$/.exec(line);
    if (!m) continue;
    const quoted = /^(["'])(.*)\1$/.exec(m[2]);
    fields[m[1]] = quoted ? quoted[2] : m[2];
  }
  return fields;
}
