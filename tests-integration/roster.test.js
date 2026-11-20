// Suite: the roster contract of squad_dump / squad_patch and the one-time
// import, in the real OpenCode 2.1.3 host, offline (RFC 0001 FR-014, FR-015,
// FR-017, FR-018, FR-020, FR-023, FR-024).
// Run: npm run test:integration   (Node >= 24)

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { storeRevision } from "../src/squad-store.js";
import { runCode } from "./host.js";

const configDir = () => path.join(process.env.XDG_CONFIG_HOME ?? "", "opencode");
const storeFile = () => path.join(configDir(), "squad.json");
afterEach(async () => {
  await fs.rm(storeFile(), { force: true });
  await fs.rm(`${storeFile()}.lock`, { force: true });
  await fs.rm(path.join(configDir(), "agent"), { recursive: true, force: true });
});

const GLOBAL_ALLOW = { permissions: [{ action: "*", resource: "*", effect: "allow" }] };
const ROSTER = JSON.stringify({ version: 1, grunts: { "p/m": {} }, drills: {} });

async function writeStore(text = ROSTER) {
  await fs.mkdir(configDir(), { recursive: true });
  await fs.writeFile(storeFile(), text);
}

/** squad_patch with the given input, as the model would call it. */
const patch = (input, opts) =>
  runCode(`return await tools.squad_patch(${JSON.stringify(input)})`, GLOBAL_ALLOW, opts);

test("FR-017: a patch built on an older revision writes nothing", async () => {
  await writeStore();
  const text = await patch({ revision: "0000000000000000", grunts: { "p/m": {}, "p/n": {} } });
  expect(text).toContain("REFUSED: squad.json changed since that squad_dump");
  expect(await fs.readFile(storeFile(), "utf8")).toBe(ROSTER);
}, 90_000);

test("FR-018: a patch that drops an agent without allow_remove writes nothing and names it", async () => {
  await writeStore();
  const text = await patch({ revision: storeRevision(storeFile()), grunts: { "p/n": {} } });
  expect(text).toContain("DELETE 1 agent(s):\n  - grunt p/m");
  expect(text).toContain("Nothing was written");
  expect(await fs.readFile(storeFile(), "utf8")).toBe(ROSTER);
}, 90_000);

test("FR-020: a grunt cannot patch the roster", async () => {
  await writeStore();
  const text = await patch(
    { revision: storeRevision(storeFile()), grunts: { "p/m": {}, "p/n": {} } },
    { agent: "grunt-p-m" },
  );
  expect(text).toContain("Refused: grunt-p-m is a subagent");
  expect(await fs.readFile(storeFile(), "utf8")).toBe(ROSTER);
}, 90_000);

test("FR-023: an unreadable squad.json is never overwritten", async () => {
  await writeStore("{ not json");
  const dump = await runCode("return await tools.squad_dump({})", GLOBAL_ALLOW);
  expect(dump).toContain("squad.json");
  expect(dump).toMatch(/not valid JSON/);
  const text = await patch({ revision: storeRevision(storeFile()), grunts: { "p/n": {} } });
  expect(text).toContain("Refused: the current squad cannot be read");
  expect(await fs.readFile(storeFile(), "utf8")).toBe("{ not json");
}, 120_000);

test("FR-024: a lock another process holds is refused and left in place", async () => {
  await writeStore();
  const lock = JSON.stringify({ pid: 1, host: "elsewhere" });
  await fs.writeFile(`${storeFile()}.lock`, lock);
  const text = await patch({
    revision: storeRevision(storeFile()),
    grunts: { "p/m": {}, "p/n": {} },
  });
  expect(text).toContain("Refused: another OpenCode process is writing squad.json right now");
  expect(await fs.readFile(`${storeFile()}.lock`, "utf8")).toBe(lock);
  expect(await fs.readFile(storeFile(), "utf8")).toBe(ROSTER);
}, 90_000);

/** An agent file as versions before 0.6.0 generated it. */
const legacy = (role, model) =>
  [
    "---",
    "# generated-by: opencode-squad squad-draft",
    'description: "stale description"',
    "mode: subagent",
    `model: ${model}`,
    "---",
    "",
    `<!-- squad:prompt role=${role} -->`,
    "stale body",
    "<!-- /squad:prompt -->",
    "",
  ].join("\n");

test("FR-014: generated agent files are imported into squad.json once and left in place", async () => {
  const dir = path.join(configDir(), "agent");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "grunt-p-m.md"), legacy("grunt", "p/m#high"));
  await fs.writeFile(path.join(dir, "drill-p-m.md"), legacy("drill", "p/m"));
  const dump = await runCode("return await tools.squad_dump({})", GLOBAL_ALLOW);
  const stored = JSON.parse(await fs.readFile(storeFile(), "utf8"));
  expect(stored).toMatchObject({
    version: 1,
    grunts: { "p/m": { variant: "high" } },
    drills: { "p/m": {} },
  });
  expect(dump).toContain("grunt-p-m.md");
  expect(await fs.readdir(dir)).toEqual(expect.arrayContaining(["grunt-p-m.md", "drill-p-m.md"]));
}, 90_000);

test("FR-015: an unreadable generated file blocks the import and is named", async () => {
  const dir = path.join(configDir(), "agent");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "grunt-p-m.md"), legacy("grunt", "p/m"));
  await fs.writeFile(path.join(dir, "drill-p-m.md"), legacy("drill", "p/m"));
  await fs.chmod(path.join(dir, "drill-p-m.md"), 0o000);
  try {
    const dump = await runCode("return await tools.squad_dump({})", GLOBAL_ALLOW);
    expect(dump).toContain("drill-p-m.md");
    await expect(fs.access(storeFile())).rejects.toThrow();
  } finally {
    await fs.chmod(path.join(dir, "drill-p-m.md"), 0o644);
  }
}, 90_000);
