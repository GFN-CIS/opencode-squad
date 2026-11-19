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
  storeSignature,
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
  expect(storeSignature(file)).toBe("-");
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
  expect(storeSignature(file)).not.toBe("-");
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

test("withStoreLock: exclusive, released after, busy while held, stale taken over", () => {
  const lock = `${file}.lock`;
  expect(withStoreLock(file, () => fs.existsSync(lock))).toEqual({ busy: false, value: true });
  expect(fs.existsSync(lock)).toBe(false);
  // Released even when the body throws.
  expect(() =>
    withStoreLock(file, () => {
      throw new Error("boom");
    }),
  ).toThrow("boom");
  // Released: an exclusive create succeeds, and stands in for another holder.
  fs.closeSync(fs.openSync(lock, "wx"));
  expect(withStoreLock(file, () => 1)).toEqual({ busy: true });
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  expect(withStoreLock(file, () => 2)).toEqual({ busy: false, value: 2 });
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
