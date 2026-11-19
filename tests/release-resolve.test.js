// Suite: scripts/release-resolve.sh — the release workflow's decision of what
// to publish and from which commit. Runs the real script in a throwaway git
// repo with fake `gh` and `npm` on PATH; nothing reaches GitHub or npm.
// Run: npx vitest run tests/release-resolve.test.js

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const SCRIPT = fileURLToPath(new URL("../scripts/release-resolve.sh", import.meta.url));
const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();

/** A repo at version 1.2.3 with commit A, then commit B on top (same version). */
function makeRepo({ tagA = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squad-release-"));
  dirs.push(dir);
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "ci@example.invalid");
  git(repo, "config", "user.name", "ci");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "tag.gpgsign", "false");
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "pkg", version: "1.2.3" }),
  );
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "A");
  const a = git(repo, "rev-parse", "HEAD");
  if (tagA) git(repo, "tag", "v1.2.3");
  fs.writeFileSync(path.join(repo, "README"), "b");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "B");
  const b = git(repo, "rev-parse", "HEAD");
  return { dir, repo, a, b };
}

/**
 * Fake CLIs. gh: "found" | "absent" | "timeout". npm: a JSON reply on stdout
 * and an exit code, as `npm view --json` gives them.
 */
function fakeBin(dir, { gh, npmOut, npmCode = 0 }) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const ghBody = {
    found: "echo v1.2.3; exit 0",
    absent: 'echo \'{"message":"Not Found","status":"404"}gh: Not Found (HTTP 404)\'; exit 1',
    timeout: 'echo "Get https://api.github.com/...: dial tcp: i/o timeout"; exit 1',
  }[gh];
  fs.writeFileSync(path.join(bin, "gh"), `#!/usr/bin/env bash\n${ghBody}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "npm-out"), npmOut);
  fs.writeFileSync(
    path.join(bin, "npm"),
    `#!/usr/bin/env bash\necho "npm error noise" >&2\ncat ${JSON.stringify(path.join(dir, "npm-out"))}\nexit ${npmCode}\n`,
    { mode: 0o755 },
  );
  return bin;
}

function run(setup, fake) {
  const out = path.join(setup.dir, "out");
  fs.writeFileSync(out, "");
  const r = spawnSync("bash", [SCRIPT], {
    cwd: setup.repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin(setup.dir, fake)}${path.delimiter}${process.env.PATH}`,
      GITHUB_SHA: setup.b,
      GITHUB_REPOSITORY: "o/r",
      GITHUB_OUTPUT: out,
    },
  });
  const outputs = Object.fromEntries(
    fs
      .readFileSync(out, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("=")),
  );
  return { status: r.status, log: r.stdout + r.stderr, outputs };
}

const E404 = JSON.stringify({ error: { code: "E404", summary: "No match found" } });
const ETIMEDOUT = JSON.stringify({ error: { code: "ETIMEDOUT", summary: "network timeout" } });
const published = (gitHead) =>
  JSON.stringify({ version: "1.2.3", ...(gitHead ? { gitHead } : {}) });

test("a fresh version releases the pushed commit", () => {
  const s = makeRepo();
  const r = run(s, { gh: "absent", npmOut: E404, npmCode: 1 });
  expect(r.status).toBe(0);
  expect(r.outputs).toMatchObject({
    sha: s.b,
    gh_release: "false",
    on_npm: "false",
    skip: "false",
  });
});

test("recovering a failed npm publish uses the tagged commit, not the newer one", () => {
  const s = makeRepo({ tagA: true });
  const r = run(s, { gh: "found", npmOut: E404, npmCode: 1 });
  expect(r.status).toBe(0);
  expect(r.outputs).toMatchObject({ sha: s.a, gh_release: "true", on_npm: "false", skip: "false" });
});

test("a complete release is left alone", () => {
  const s = makeRepo({ tagA: true });
  const r = run(s, { gh: "found", npmOut: published(s.a) });
  expect(r.status).toBe(0);
  expect(r.outputs).toMatchObject({ skip: "true" });
});

test("an npm timeout is unknown, not unpublished", () => {
  const s = makeRepo({ tagA: true });
  const r = run(s, { gh: "found", npmOut: ETIMEDOUT, npmCode: 1 });
  expect(r.status).toBe(1);
  expect(r.log).toMatch(/Cannot tell whether npm has pkg@1\.2\.3 \(ETIMEDOUT\)/);
  expect(r.outputs).toEqual({});
});

test("an empty npm reply is unknown too", () => {
  const s = makeRepo();
  const r = run(s, { gh: "absent", npmOut: "", npmCode: 1 });
  expect(r.status).toBe(1);
  expect(r.log).toMatch(/Cannot tell whether npm has/);
});

test("a GitHub API failure is unknown, not a missing release", () => {
  const s = makeRepo();
  const r = run(s, { gh: "timeout", npmOut: E404, npmCode: 1 });
  expect(r.status).toBe(1);
  expect(r.log).toMatch(/Cannot tell whether release v1\.2\.3 exists/);
});

test("published on npm with no known commit: no GitHub release is created on a guess", () => {
  const s = makeRepo();
  for (const npmOut of [published(null), published("0".repeat(40))]) {
    const r = run(s, { gh: "absent", npmOut });
    expect(r.status).toBe(1);
    expect(r.log).toMatch(/refusing to create release v1\.2\.3/);
  }
});

test("a complete release with a stale gitHead only warns", () => {
  const s = makeRepo({ tagA: true });
  const r = run(s, { gh: "found", npmOut: published("0".repeat(40)) });
  expect(r.status).toBe(0);
  expect(r.log).toMatch(/::warning::npm pkg@1\.2\.3 records gitHead/);
  expect(r.outputs.skip).toBe("true");
});

test("a release without its tag stops the run", () => {
  const s = makeRepo();
  const r = run(s, { gh: "found", npmOut: E404, npmCode: 1 });
  expect(r.status).toBe(1);
  expect(r.log).toMatch(/exists but its tag does not/);
});
