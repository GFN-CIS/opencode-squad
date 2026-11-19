// Whole-file replacement that a concurrent reader (opencode's agent watcher,
// another plugin instance, the user's editor) never sees half-written: write
// a temp file next to the real target, then rename it over the target. On
// failure the temp file is removed and the original is left untouched.
//
// A symlinked path (a dotfiles checkout) is written THROUGH: the temp file goes
// beside the link's target and replaces that, so the link survives and the
// repo copy is the one updated. A DANGLING link (the checkout is absent) is
// refused rather than replaced by a regular file, which would silently detach
// the path from the repo copy. The existing file's permission bits are kept —
// model_data.json can hold private routing rules and may be 0600.

import fs from "node:fs";
import path from "node:path";

let seq = 0;

/** @param {string} file */
function resolveTarget(file) {
  try {
    return fs.realpathSync(file);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e)?.code !== "ENOENT") throw e;
    const link = danglingLinkTarget(file);
    if (link === null) return file; // a new file
    throw Object.assign(
      new Error(`${file} is a symlink to ${link}, which does not exist; the link is left in place`),
      { code: "ENOENT", path: file },
    );
  }
}

/**
 * Where `file` points if it is a symlink whose target does not exist, else
 * null (no such path, or not a dangling link).
 *
 * @param {string} file
 * @returns {string | null}
 */
export function danglingLinkTarget(file) {
  let link;
  try {
    if (!fs.lstatSync(file).isSymbolicLink()) return null;
    link = fs.readlinkSync(file);
  } catch {
    return null;
  }
  return fs.existsSync(file) ? null : link;
}

/**
 * @param {string} file  destination path; its directory must exist
 * @param {string} content
 */
export function writeFileAtomic(file, content) {
  const target = resolveTarget(file);
  /** @type {number | undefined} */
  let mode;
  try {
    mode = fs.statSync(target).mode & 0o7777;
  } catch {
    // New file: the process umask decides, as for a plain write.
  }
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${++seq}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, content, mode === undefined ? undefined : { mode });
    if (mode !== undefined) fs.chmodSync(tmp, mode); // the umask may have masked bits
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
