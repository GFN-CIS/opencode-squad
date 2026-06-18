/**
 * opencode-orchestrate plugin entry.
 *
 * Responsibilities:
 *   1. Register the bundled worker / work-reviewer subagents (only if the user
 *      has not already defined an agent with that name).
 *   2. Register the bundled skills directory so orchestrating-subagents is
 *      discoverable.
 *   3. Inject a hidden orchestrator bootstrap (with a live subagent inventory)
 *      into the first user message of a session.
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { agentDefinitions } from "../../src/agents.js";
import { formatInventory } from "../../src/inventory.js";
import { buildBootstrap, BOOTSTRAP_MARKER } from "../../src/bootstrap.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "../..");
const PROMPTS_DIR = path.join(PACKAGE_ROOT, "prompts");
const SKILLS_DIR = path.join(PACKAGE_ROOT, "skills");

// The primary agent that acts as the orchestrator. Injection targets only this
// agent's sessions (verified via message.info.agent in the Task 0 spike).
const ORCHESTRATOR_AGENT = "build";

// Cache the assembled bootstrap per process (inventory is read once).
let _bootstrapCache; // undefined = not loaded

/** @type {import("@opencode-ai/plugin").Plugin} */
export const OrchestratePlugin = async ({ client }) => {
  const getBootstrap = async () => {
    if (_bootstrapCache !== undefined) return _bootstrapCache;
    let inventory = "(no subagents available)";
    try {
      const res = await client.app.agents();
      inventory = formatInventory(res?.data ?? []);
    } catch {
      // Inventory is best-effort; the bootstrap still works without it.
    }
    _bootstrapCache = buildBootstrap(inventory);
    return _bootstrapCache;
  };

  return {
    config: async (config) => {
      // Register bundled skills directory (runtime field, untyped).
      if (fs.existsSync(SKILLS_DIR)) {
        const cfg = /** @type {any} */ (config);
        cfg.skills = cfg.skills || {};
        cfg.skills.paths = cfg.skills.paths || [];
        if (!cfg.skills.paths.includes(SKILLS_DIR)) {
          cfg.skills.paths.push(SKILLS_DIR);
        }
      }

      // Define bundled subagents only if the user has not defined them.
      config.agent = config.agent || {};
      const defs = agentDefinitions(PROMPTS_DIR);
      for (const [name, def] of Object.entries(defs)) {
        if (!config.agent[name]) {
          config.agent[name] = def;
        }
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      if (!output.messages || output.messages.length === 0) return;
      const firstUser = output.messages.find((m) => m?.info?.role === "user");
      if (!firstUser || !firstUser.parts || firstUser.parts.length === 0) return;

      // Only inject for the orchestrator (primary build agent). The hook's
      // `input` is empty, but each message carries `info.agent` (verified in
      // the Task 0 spike: "build" for the primary session, the subagent name
      // for worker/work-reviewer sessions). This skips subagent sessions.
      if (firstUser.info?.agent !== ORCHESTRATOR_AGENT) return;

      // Guard against double injection.
      if (
        firstUser.parts.some(
          (p) => p?.type === "text" && p.text && p.text.includes(BOOTSTRAP_MARKER),
        )
      ) {
        return;
      }

      const bootstrap = await getBootstrap();
      const ref = firstUser.parts[0];
      firstUser.parts.unshift({ ...ref, type: "text", text: bootstrap });
    },
  };
};

export default { id: "orchestrate", server: OrchestratePlugin };
