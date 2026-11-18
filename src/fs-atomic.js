// Whole-file replacement that a concurrent reader (opencode's agent watcher,
// another plugin instance, the user's editor) never sees half-written: write
// a temp file in the destination directory, then rename it over the target.
// On failure the temp file is removed and the original is left untouched.

import fs from "node:fs";
import path from "node:path";

let seq = 0;

/**
 * @param {string} file  destination path; its directory must exist
 * @param {string} content
 */
export function writeFileAtomic(file, content) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${++seq}.tmp`);
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
