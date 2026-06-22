// Programmatic definitions for the bundled grunt (worker) and drill (reviewer)
// subagents. Prompts are read from disk so they can be edited without code.

import fs from "node:fs";
import path from "node:path";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

/**
 * @param {string} promptsDir absolute path to the bundled prompts/ directory
 * @returns {{ grunt: object, drill: object }}
 */
export function agentDefinitions(promptsDir) {
  const read = (name) =>
    fs.readFileSync(path.join(promptsDir, name), "utf8");

  return {
    grunt: {
      description:
        "Worker (grunt) for the sarge orchestrator's PDCA cycle. Receives a task brief and definition of done, performs the work, returns a structured result.",
      mode: "subagent",
      model: DEFAULT_MODEL,
      hidden: true,
      prompt: read("grunt.md"),
      permission: {
        edit: "allow",
        bash: "allow",
        task: { "*": "deny" },
      },
    },
    drill: {
      description:
        "Reviewer (drill) for the sarge orchestrator's PDCA cycle. Reads the actual artifacts, judges against the definition of done, returns a strict JSON verdict.",
      mode: "subagent",
      model: DEFAULT_MODEL,
      hidden: true,
      prompt: read("drill.md"),
      permission: {
        edit: "deny",
        bash: "deny",
        webfetch: "allow",
        task: { "*": "deny" },
      },
    },
  };
}
