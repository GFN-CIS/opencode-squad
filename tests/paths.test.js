import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { opencodeConfigDir, opencodeDataDir } from "../src/paths.js";
import { defaultAgentDir } from "../src/squad-apply.js";

test("opencodeConfigDir honors XDG_CONFIG_HOME, its absence, and empty string", () => {
  expect(opencodeConfigDir({ XDG_CONFIG_HOME: "/xdg/cfg" }, "/home/u")).toBe(
    path.join("/xdg/cfg", "opencode"),
  );
  expect(opencodeConfigDir({}, "/home/u")).toBe(path.join("/home/u", ".config", "opencode"));
  expect(opencodeConfigDir({ XDG_CONFIG_HOME: "" }, "/home/u")).toBe(
    path.join("/home/u", ".config", "opencode"),
  );
});

test("opencodeDataDir honors XDG_DATA_HOME, its absence, and empty string", () => {
  expect(opencodeDataDir({ XDG_DATA_HOME: "/xdg/data" }, "/home/u")).toBe(
    path.join("/xdg/data", "opencode"),
  );
  expect(opencodeDataDir({}, "/home/u")).toBe(path.join("/home/u", ".local", "share", "opencode"));
  expect(opencodeDataDir({ XDG_DATA_HOME: "" }, "/home/u")).toBe(
    path.join("/home/u", ".local", "share", "opencode"),
  );
});

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
afterEach(() => {
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
});

test("defaultAgentDir honors XDG_CONFIG_HOME", () => {
  process.env.XDG_CONFIG_HOME = "/xdg/cfg";
  expect(defaultAgentDir()).toBe(path.join("/xdg/cfg", "opencode", "agent"));
});

// The dotdir building blocks live only in src/paths.js (XDG-aware) and
// src/benchmark-cache.js (cacheDir); tmp paths use os.tmpdir(), never a
// hardcoded "/tmp/" literal — that only exists on this dev machine, not CI.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GUARD_SELF = path
  .relative(ROOT, fileURLToPath(import.meta.url))
  .split(path.sep)
  .join("/");
const DOTDIR_ALLOWED = new Set(["src/paths.js", "src/benchmark-cache.js"]);
const GUARD_ROOTS = ["src", path.join(".opencode", "lib"), "scripts", "tests"];

function listJsFiles(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) listJsFiles(full, out);
    else if (/\.(js|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

test("regression guard: dotdir path segments and /tmp literals stay where they belong", () => {
  const offenders = [];
  for (const root of GUARD_ROOTS) {
    for (const file of listJsFiles(path.join(ROOT, root))) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      if (rel === GUARD_SELF) continue;
      const text = fs.readFileSync(file, "utf8");
      if (!DOTDIR_ALLOWED.has(rel) && /"\.(?:config|local)"/.test(text)) {
        offenders.push(`${rel}: ".config"/".local" path segment`);
      }
      if (rel.startsWith("tests/") && /"\/tmp\//.test(text)) {
        offenders.push(`${rel}: "/tmp/" string literal`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
