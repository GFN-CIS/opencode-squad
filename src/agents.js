// Programmatic definitions for the bundled worker and work-reviewer subagents.
// Prompts are read from disk so they can be edited without touching code.

import fs from "node:fs";
import path from "node:path";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

/**
 * @param {string} promptsDir absolute path to the bundled prompts/ directory
 * @returns {{ worker: object, "work-reviewer": object }}
 */
export function agentDefinitions(promptsDir) {
  const read = (name) =>
    fs.readFileSync(path.join(promptsDir, name), "utf8");

  return {
    worker: {
      description:
        "Generic executor for orchestrator-driven PDCA cycles. Receives a task brief and definition of done, performs the work, returns a structured result.",
      mode: "subagent",
      model: DEFAULT_MODEL,
      hidden: true,
      prompt: read("worker.md"),
      permission: {
        edit: "allow",
        bash: "allow",
        task: { "*": "deny" },
      },
    },
    "work-reviewer": {
      description:
        "Generic reviewer for orchestrator-driven PDCA cycles. Reads the actual artifacts, judges against the definition of done, returns a strict JSON verdict.",
      mode: "subagent",
      model: DEFAULT_MODEL,
      hidden: true,
      prompt: read("work-reviewer.md"),
      permission: {
        edit: "deny",
        bash: "deny",
        webfetch: "allow",
        task: { "*": "deny" },
      },
    },
  };
}
