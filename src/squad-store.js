// The squad roster's one home: a JSON file the plugin owns, beside
// model_data.json in the OpenCode config dir. OpenCode never reads it; the
// plugin registers the agents it describes through the agent API
// (src/squad-agents.js), so no agent file is written, pruned or migrated
// (#85, which ended the file-aliasing class of bugs in #16, #51, #52).
//
// A file that exists but does not parse or validate is never overwritten:
// it may hold the user's squad, and a fresh one written over it would lose
// that squad for good. Callers report it and refuse to change the roster.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeFileAtomic } from "./fs-atomic.js";
import { opencodeConfigDir } from "./paths.js";
import { validateRoster } from "./roster-schema.js";

const STORE_VERSION = 1;

/** The global roster file. */
export function defaultStoreFile() {
  return path.join(opencodeConfigDir(process.env, os.homedir()), "squad.json");
}

/**
 * @typedef {{grunts: Record<string, Record<string, any>>, drills: Record<string, Record<string, any>>}} Roster
 * @typedef {{state: "missing"} | {state: "ok", roster: Roster} | {state: "invalid", reason: string}} StoreRead
 */

/**
 * @param {string} file
 * @returns {StoreRead}
 */
export function readStore(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e)?.code;
    if (code === "ENOENT") return { state: "missing" };
    return { state: "invalid", reason: `cannot read (${code ?? "error"})` };
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { state: "invalid", reason: `not valid JSON (${/** @type {Error} */ (e).message})` };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { state: "invalid", reason: "not a JSON object" };
  }
  const { version, ...roster } = doc;
  if (version !== STORE_VERSION) {
    return { state: "invalid", reason: `unsupported version ${JSON.stringify(version ?? null)}` };
  }
  const errors = validateRoster(roster);
  if (errors.length) return { state: "invalid", reason: errors.join("; ") };
  return { state: "ok", roster: normalize(roster) };
}

/**
 * Write the roster, keys sorted so the file diffs cleanly under version
 * control. Atomic: a concurrent reader never sees half a squad.
 *
 * @param {string} file
 * @param {{grunts?: Record<string, any>, drills?: Record<string, any>}} roster
 */
export function writeStore(file, roster) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const r = normalize(roster);
  writeFileAtomic(file, `${JSON.stringify({ version: STORE_VERSION, ...r }, null, 2)}\n`);
}

/**
 * The file's change signature: other OpenCode processes write it too (the
 * desktop service and a CLI share one config dir).
 *
 * @param {string} file
 */
export function storeSignature(file) {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "-";
  }
}

/**
 * @param {{grunts?: Record<string, any>, drills?: Record<string, any>}} roster
 * @returns {Roster}
 */
function normalize(roster) {
  /** @param {Record<string, any> | undefined} map */
  const sorted = (map) =>
    Object.fromEntries(Object.entries(map ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  return { grunts: sorted(roster.grunts), drills: sorted(roster.drills) };
}
