// Suite: scripts/squad-measure-cache-ttl.mjs — CLI argument handling and the
// storage layouts it reads (OpenCode 2, OpenCode 1, neither). Runs the script
// as a child process against throwaway SQLite files with synthetic rows; never
// touches the real opencode database. Run: npx vitest run tests/cache-ttl-measure-cli.test.js

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const SCRIPT = fileURLToPath(new URL("../scripts/squad-measure-cache-ttl.mjs", import.meta.url));

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** @param {string[]} args */
const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

test("a --db without a value is a usage error, not a filesystem error", () => {
  const r = run(["--db"]);
  expect(r.status).toBe(2);
  expect(r.stderr).toMatch(/--db/);
  expect(r.stderr).toMatch(/Usage:/);
});

test("an unknown option is a usage error", () => {
  const r = run(["--bogus"]);
  expect(r.status).toBe(2);
  expect(r.stderr).toMatch(/Unknown option '--bogus'/);
});

test("a valid --db is read; an empty history reports that nothing is usable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squad-ttl-cli-"));
  dirs.push(dir);
  const file = path.join(dir, "opencode.db");
  const db = new DatabaseSync(file);
  db.exec(
    "create table session (id text); create table message (session_id text, data text, time_created integer);",
  );
  db.close();
  const r = run(["--db", file, "--json"]);
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/No usable samples/);
});

/** A throwaway database file. @param {string} sql */
function makeDb(sql) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squad-ttl-cli-"));
  dirs.push(dir);
  const file = path.join(dir, "opencode.db");
  const db = new DatabaseSync(file);
  db.exec(sql);
  return { file, db };
}

// The OpenCode 2 tables, cut down to the columns the script reads.
const V2_SCHEMA =
  "create table session_v2 (id text primary key);" +
  "create table session_message (id text primary key, session_id text not null, type text not null," +
  " seq integer not null, time_created integer not null, data text not null);";

/**
 * One OpenCode 2 session: 21 assistant turns 60s apart that hit the cache,
 * then a compaction and one more turn. The 20 consecutive pairs are usable;
 * the pair ending on the compaction is not, and the compaction's own small
 * prompt is too short to pair with the turn after it.
 *
 * @param {DatabaseSync} db
 */
function fillV2(db) {
  db.prepare("insert into session_v2 (id) values (?)").run("ses_1");
  const add = db.prepare(
    "insert into session_message (id, session_id, type, seq, time_created, data) values (?, 'ses_1', ?, ?, ?, ?)",
  );
  const T0 = 1_800_000_000_000;
  const model = { id: "model-x", providerID: "prov", variant: "high" };
  const turn = (i) => ({
    time: { created: T0 + i * 60_000, completed: T0 + i * 60_000 + 5_000 },
    model,
    finish: "stop",
    tokens: { input: 20, output: 300, reasoning: 0, cache: { read: 9_000 + i * 50, write: 400 } },
  });
  let seq = 0;
  for (let i = 0; i < 21; i++)
    add.run(`m${i}`, "assistant", seq++, T0 + i * 60_000, JSON.stringify(turn(i)));
  const compaction = {
    time: { created: T0 + 21 * 60_000 },
    model,
    status: "completed",
    summary: "…",
    tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  add.run("c1", "compaction", seq++, T0 + 21 * 60_000, JSON.stringify(compaction));
  add.run("m21", "assistant", seq++, T0 + 22 * 60_000, JSON.stringify(turn(22)));
  // Rows the script must skip.
  add.run("u1", "user", seq++, T0, JSON.stringify({ time: { created: T0 }, text: "hi" }));
  add.run("bad", "assistant", seq++, T0, "{not json");
}

/** @param {string} file */
const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

test("an OpenCode 2 database is read from session_v2/session_message, read-only", () => {
  const { file, db } = makeDb(V2_SCHEMA);
  fillV2(db);
  db.close();
  const before = digest(file);
  const r = run(["--db", file, "--json"]);
  // Node may print an ExperimentalWarning for node:sqlite; nothing else.
  expect(r.stderr).not.toMatch(/Unsupported|No usable|Error:/);
  expect(r.status).toBe(0);
  const out = JSON.parse(r.stdout);
  expect(out.storage).toBe("OpenCode 2");
  expect(out.samples).toBe(20);
  expect(Object.keys(out.providers)).toEqual(["prov"]);
  expect(digest(file)).toBe(before);
  // The text report names the storage too.
  expect(run(["--db", file]).stdout).toMatch(/\(OpenCode 2 storage\)/);
});

test("where OpenCode 1 tables remain beside OpenCode 2 ones, only OpenCode 2 is read", () => {
  const { file, db } = makeDb(
    `${V2_SCHEMA} create table session (id text); create table message (session_id text, data text, time_created integer);`,
  );
  fillV2(db);
  // The same session, migrated: counted once.
  db.exec("insert into session (id) values ('ses_1')");
  const legacy = db.prepare(
    "insert into message (session_id, data, time_created) values ('ses_1', ?, ?)",
  );
  for (let i = 0; i < 5; i++) {
    legacy.run(
      JSON.stringify({
        role: "assistant",
        providerID: "prov",
        modelID: "model-x",
        time: { created: i * 60_000 },
        tokens: { total: 9_000, cache: { read: 8_000 } },
      }),
      i * 60_000,
    );
  }
  db.close();
  const out = JSON.parse(run(["--db", file, "--json"]).stdout);
  expect(out.samples).toBe(20);
});

test("a database with neither layout gets a clear error", () => {
  const { file, db } = makeDb("create table something_else (id text);");
  db.close();
  const r = run(["--db", file]);
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/Unsupported opencode storage/);
  expect(r.stderr).toMatch(/session_v2, session_message/);
});
