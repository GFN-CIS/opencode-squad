// Runs before every unit test file: point the OpenCode config and data dirs
// at a throwaway directory, so no test can read or write the real user's
// squad.json, model_data.json or agent dir even when it forgets to set its
// own. A test that needs a specific layout still sets XDG_* itself.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "squad-unit-"));
for (const [key, dir] of [
  ["XDG_CONFIG_HOME", "config"],
  ["XDG_DATA_HOME", "data"],
]) {
  const full = path.join(root, dir);
  fs.mkdirSync(full, { recursive: true });
  process.env[key] = full;
}

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
