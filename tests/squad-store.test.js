// Suite: src/squad-store.js — the roster file the plugin owns (#85).
// Run: npx vitest run tests/squad-store.test.js

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  defaultStoreFile,
  NO_STORE_REVISION,
  readStore,
  storeRevision,
  withStoreLock,
  writeStore,
} from "../src/squad-store.js";

let dir;
let file;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "squad-store-"));
  file = path.join(dir, "squad.json");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a missing file is no squad, not an error", () => {
  expect(readStore(file)).toEqual({ state: "missing" });
  expect(storeRevision(file)).toBe(NO_STORE_REVISION);
});

test("write then read round-trips, keys sorted, with the format version", () => {
  writeStore(file, { grunts: { "z/b": { variant: "high" }, "a/b": {} }, drills: {} });
  const text = fs.readFileSync(file, "utf8");
  expect(JSON.parse(text)).toEqual({
    version: 1,
    grunts: { "a/b": {}, "z/b": { variant: "high" } },
    drills: {},
  });
  expect(text.indexOf('"a/b"')).toBeLessThan(text.indexOf('"z/b"'));
  expect(readStore(file)).toEqual({
    state: "ok",
    roster: { grunts: { "a/b": {}, "z/b": { variant: "high" } }, drills: {} },
    revision: storeRevision(file),
  });
});

test("the revision is of the bytes: any edit changes it, none means no file (#89)", () => {
  expect(storeRevision(file)).toBe(NO_STORE_REVISION);
  writeStore(file, { grunts: { "a/b": { notes: "x" } }, drills: {} });
  const first = storeRevision(file);
  expect(first).toMatch(/^[0-9a-f]{16}$/);
  // Same length, same second: mtime and size would not see it.
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"x"', '"y"'));
  expect(storeRevision(file)).not.toBe(first);
  fs.chmodSync(file, 0o000);
  expect(storeRevision(file)).toBeNull();
  fs.chmodSync(file, 0o600);
});

test("withStoreLock: exclusive while held, released after, even after a throw", () => {
  const lock = `${file}.lock`;
  // Held while the body runs, by this process.
  const held = withStoreLock(file, () => JSON.parse(fs.readFileSync(lock, "utf8")));
  expect(held).toMatchObject({ busy: false, value: { pid: process.pid } });
  expect(() =>
    withStoreLock(file, () => {
      throw new Error("boom");
    }),
  ).toThrow("boom");
  // Released both times: an exclusive create succeeds.
  fs.closeSync(fs.openSync(lock, "wx"));
});

test("a lock is never taken over, however old or whoever held it (#89)", () => {
  const lock = `${file}.lock`;
  const old = new Date(Date.now() - 600_000);
  // A process that is gone, and one that is alive (this one) but slow.
  for (const pid of [2 ** 22 + 12345, process.pid]) {
    const text = JSON.stringify({ pid, host: "h", token: "theirs" });
    fs.writeFileSync(lock, text);
    fs.utimesSync(lock, old, old);
    const out = withStoreLock(file, () => "entered");
    expect(out).toMatchObject({ busy: true, holder: { pid } });
    expect(out.holder.ageMs).toBeGreaterThan(500_000);
    expect(fs.readFileSync(lock, "utf8")).toBe(text);
  }
  fs.rmSync(lock);
});

test("release removes only the lock this call created (#89)", () => {
  const lock = `${file}.lock`;
  const other = JSON.stringify({ pid: 1, host: "h", token: "someone else" });
  withStoreLock(file, () => {
    // Someone deleted ours and took the path meanwhile.
    fs.rmSync(lock);
    fs.writeFileSync(lock, other);
  });
  expect(fs.readFileSync(lock, "utf8")).toBe(other);
  fs.rmSync(lock);
});

test.each([
  ["{not json", /not valid JSON/],
  ["[]", /not a JSON object/],
  [JSON.stringify({ grunts: {} }), /unsupported version null/],
  [JSON.stringify({ version: 2, grunts: {} }), /unsupported version 2/],
  [JSON.stringify({ version: 1, grunts: { "no-slash": {} } }), /grunts/],
  [JSON.stringify({ version: 1, grunts: { "a/b": { description: "x" } } }), /description/],
])("an invalid file is reported, never read as empty: %s", (text, reason) => {
  fs.writeFileSync(file, text);
  const read = readStore(file);
  expect(read.state).toBe("invalid");
  expect(read.state === "invalid" ? read.reason : "").toMatch(reason);
});

test("the default file sits in the OpenCode config dir", () => {
  const old = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = "/xdg/cfg";
  try {
    expect(defaultStoreFile()).toBe(path.join("/xdg/cfg", "opencode", "squad.json"));
  } finally {
    process.env.XDG_CONFIG_HOME = old;
  }
});
