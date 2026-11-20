// Suite: model_data.json at startup, in the real OpenCode 2.1.3 host
// (RFC 0001 FR-028).
// Run: npm run test:integration   (Node >= 24)

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { runCode } from "./host.js";

const configDir = () => path.join(process.env.XDG_CONFIG_HOME ?? "", "opencode");
const storeFile = () => path.join(configDir(), "squad.json");
const globalFile = () => path.join(configDir(), "model_data.json");
afterEach(async () => {
  await fs.rm(storeFile(), { force: true });
  await fs.rm(globalFile(), { force: true });
});

test("FR-028: the global file follows the squad and keeps hand-written fields; a project's is never written", async () => {
  await fs.mkdir(configDir(), { recursive: true });
  await fs.writeFile(
    storeFile(),
    JSON.stringify({ version: 1, grunts: { "p/m": {}, "p/n": {} }, drills: {} }),
  );
  await fs.writeFile(
    globalFile(),
    JSON.stringify({
      providers: { p: "Max" },
      models: { "p/m": { info: "keep me", billing: "api" }, "p/gone": {} },
    }),
  );
  // The project's file is a link to one outside the project, which outlives
  // the host: a write goes through the link (src/fs-atomic.js) and shows here.
  const projectText = '{"models": {"p/m": {"info": "project rule"}}}';
  const outside = path.join(process.env.TMPDIR ?? "", "project-model-data.json");
  await fs.writeFile(outside, projectText);
  await runCode(
    "return 1",
    { permissions: [{ action: "*", resource: "*", effect: "allow" }] },
    {
      prepare: async (project) => {
        const link = path.join(project, ".opencode", "model_data.json");
        await fs.mkdir(path.dirname(link), { recursive: true });
        await fs.symlink(outside, link);
      },
    },
  );
  const after = JSON.parse(await fs.readFile(globalFile(), "utf8"));
  expect(after.providers).toEqual({ p: "Max" });
  expect(after.models["p/m"]).toEqual({ info: "keep me", billing: "api" });
  expect(after.models["p/n"]).toEqual({ info: "" });
  expect(after.models).not.toHaveProperty("p/gone");
  expect(await fs.readFile(outside, "utf8")).toBe(projectText);
}, 90_000);
