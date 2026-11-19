// The squad roster's one home: a JSON file the plugin owns, beside
// model_data.json in the OpenCode config dir. OpenCode never reads it; the
// plugin registers the agents it describes through the agent API
// (src/squad-agents.js), so no agent file is written, pruned or migrated
// (#85, which ended the file-aliasing class of bugs in #16, #51, #52).
//
// A file that exists but does not parse or validate is never overwritten:
// it may hold the user's squad, and a fresh one written over it would lose
// that squad for good. Callers report it and refuse to change the roster.

import crypto from "node:crypto";
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
 * @typedef {{state: "missing"} | {state: "ok", roster: Roster, revision: string} | {state: "invalid", reason: string}} StoreRead
 *   revision: of the bytes this roster was read from (storeRevision)
 */

/**
 * @param {string} file
 * @returns {StoreRead}
 */
export function readStore(file) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e)?.code;
    if (code === "ENOENT") return { state: "missing" };
    return { state: "invalid", reason: `cannot read (${code ?? "error"})` };
  }
  const text = bytes.toString("utf8");
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
  return { state: "ok", roster: normalize(roster), revision: revisionOf(bytes) };
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

/** The revision of a roster that has no squad.json yet. */
export const NO_STORE_REVISION = "none";

/**
 * The file's content revision: squad_dump prints it and squad_patch must
 * pass it back, so a patch built on a roster that changed since is refused
 * instead of silently reverting that change (#89). A hash of the bytes, not
 * mtime and size: an edit within one timestamp tick or of equal length still
 * counts.
 *
 * @param {string} file
 * @returns {string | null}  null when the file exists but cannot be read
 */
export function storeRevision(file) {
  try {
    return revisionOf(fs.readFileSync(file));
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e)?.code === "ENOENT" ? NO_STORE_REVISION : null;
  }
}

/** @param {Buffer} bytes */
function revisionOf(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/** A lock older than this was left by a process that died holding it. */
const LOCK_STALE_MS = 30_000;

/**
 * Run `fn` holding `<file>.lock`, created exclusively: another OpenCode
 * process sharing the config dir (the desktop service and a CLI do) cannot
 * read-check-write the roster at the same time. `fn` must be synchronous;
 * with no await inside, no other patch of this process interleaves either.
 * Busy is reported, not waited out: the caller retries with a fresh dump.
 *
 * @template T
 * @param {string} file
 * @param {() => T} fn
 * @returns {{busy: true} | {busy: false, value: T}}
 */
export function withStoreLock(file, fn) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  for (let attempt = 0; attempt < 2 && fd === undefined; attempt++) {
    try {
      fd = fs.openSync(lock, "wx");
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e)?.code !== "EEXIST") throw e;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        // Released meanwhile: try again.
      }
      if (age <= LOCK_STALE_MS) return { busy: true };
      fs.rmSync(lock, { force: true });
    }
  }
  if (fd === undefined) return { busy: true };
  try {
    fs.writeSync(fd, String(process.pid));
    return { busy: false, value: fn() };
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
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
