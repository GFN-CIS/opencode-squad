// Suite: src/fs-atomic.js — atomic whole-file writes. Covers symlinked
// destinations (written through, link kept), a dangling link refused and
// kept, permission bits kept, and no temp file left behind. Run: npx vitest run tests/fs-atomic.test.js

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { writeFileAtomic } from "../src/fs-atomic.js";

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "squad-atomic-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a new file is created and nothing else is left in the directory", () => {
  const file = path.join(dir, "a.json");
  writeFileAtomic(file, "one");
  expect(fs.readFileSync(file, "utf8")).toBe("one");
  expect(fs.readdirSync(dir)).toEqual(["a.json"]);
});

test("a symlinked destination is written through and stays a link", () => {
  const real = path.join(dir, "dotfiles", "model_data.json");
  fs.mkdirSync(path.dirname(real));
  fs.writeFileSync(real, "old");
  const link = path.join(dir, "model_data.json");
  fs.symlinkSync(real, link);
  writeFileAtomic(link, "new");
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(real, "utf8")).toBe("new");
  expect(fs.readdirSync(path.dirname(real))).toEqual(["model_data.json"]);
});

test("a dangling symlink is refused, not replaced by a regular file", () => {
  const missing = path.join(dir, "dotfiles", "model_data.json");
  const link = path.join(dir, "model_data.json");
  fs.symlinkSync(missing, link);
  expect(() => writeFileAtomic(link, "new")).toThrow(/does not exist/);
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(fs.readlinkSync(link)).toBe(missing);
  expect(fs.readdirSync(dir)).toEqual(["model_data.json"]);
});

test("the existing file's permission bits are kept", () => {
  const file = path.join(dir, "private.json");
  fs.writeFileSync(file, "old", { mode: 0o600 });
  writeFileAtomic(file, "new");
  // One descriptor for both checks, so they see the same file.
  const fd = fs.openSync(file, "r");
  try {
    expect(fs.fstatSync(fd).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(fd, "utf8")).toBe("new");
  } finally {
    fs.closeSync(fd);
  }
});

test("a failed write leaves the original and no temp file", () => {
  const file = path.join(dir, "a.json");
  fs.writeFileSync(file, "keep");
  // Renaming a file over a non-empty directory fails.
  const blocker = path.join(dir, "dir.json");
  fs.mkdirSync(blocker);
  fs.writeFileSync(path.join(blocker, "x"), "");
  expect(() => writeFileAtomic(blocker, "x")).toThrow();
  expect(fs.readFileSync(file, "utf8")).toBe("keep");
  expect(fs.readdirSync(dir).sort()).toEqual(["a.json", "dir.json"]);
});
