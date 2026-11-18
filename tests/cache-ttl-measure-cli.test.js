// Suite: scripts/squad-measure-cache-ttl.mjs — CLI argument handling. Runs the
// script as a child process against a throwaway SQLite file; never touches the
// real opencode database. Run: npx vitest run tests/cache-ttl-measure-cli.test.js

import { spawnSync } from "node:child_process";
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
