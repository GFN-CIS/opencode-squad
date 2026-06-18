# opencode-orchestrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an OpenCode plugin package (`opencode-orchestrate`) that turns the `build` agent into a PDCA orchestrator delegating to bundled `worker`/`work-reviewer` subagents.

**Architecture:** A single npm-style package installed via `git+https://`. A plugin (`.opencode/plugins/orchestrate.js`) uses the `config` hook to register bundled subagents + a skills directory, and the `experimental.chat.messages.transform` hook to inject a hidden orchestrator bootstrap (with a live subagent inventory) into the first user message. Pure logic lives in small `src/` modules with unit tests; prompts and the skill are static files.

**Tech Stack:** JavaScript (ESM), Bun (test runner + install), `@opencode-ai/plugin` (peer dep), `@opencode-ai/sdk` (dev dep, types only).

## Global Constraints

- Runtime: ESM modules only (`"type": "module"` in package.json). Use `import`, never `require`.
- Node built-ins imported with the `node:` prefix (`node:path`, `node:fs`, `node:url`).
- Test runner: `bun test`. Test files end in `.test.js` and live in `tests/`.
- Plugin entry path is exactly `.opencode/plugins/orchestrate.js` and must match `package.json` `main`.
- Plugin export form: `export default { server: OrchestratePlugin }` (matches opencode-time-logger).
- Default subagent model: `anthropic/claude-sonnet-4-6`. Never hardcode any other model.
- Code comments in English.
- Subagent names are exactly `worker` and `work-reviewer` (with hyphen).
- Verified API facts (do not re-investigate): `client.app.agents()` → `{ data: Agent[] }` where `Agent = { name, description?, mode: "subagent"|"primary"|"all", builtIn, model?: {modelID, providerID}, prompt?, ... }`. `config.agent` is `{ [name: string]: AgentConfig }`. The transform hook signature is `(input: {}, output: { messages: { info: Message; parts: Part[] }[] }) => Promise<void>`.
- License: MIT. Author: AlexMKX. Repo URL: `git+https://github.com/AlexMKX/opencode-orchestrate.git`.

---

## File Structure

- `package.json` — package metadata, deps, `main`, test script.
- `.gitignore` — already exists (node_modules, logs). Extend if needed.
- `LICENSE` — MIT text.
- `.github/workflows/test.yml` — CI: bun install + bun test on PR to main.
- `src/inventory.js` — `formatInventory(agents)`: pure function turning an `Agent[]` into the inventory markdown string for the bootstrap. No I/O.
- `src/bootstrap.js` — `buildBootstrap(inventoryMarkdown)`: pure function assembling the full hidden bootstrap block from the static template + inventory. No I/O.
- `src/agents.js` — `agentDefinitions(promptsDir)`: returns `{ worker, "work-reviewer" }` AgentConfig objects, reading prompt bodies from `prompts/` via `fs`.
- `prompts/worker.md` — worker system prompt (static).
- `prompts/work-reviewer.md` — reviewer system prompt (static).
- `skills/orchestrating-subagents/SKILL.md` — PDCA workflow skill (static, on-demand).
- `.opencode/plugins/orchestrate.js` — plugin entry; wires hooks; imports from `src/`.
- `tests/inventory.test.js`, `tests/bootstrap.test.js`, `tests/agents.test.js` — unit tests.
- `docs/spikes/2026-06-18-transform-hook.md` — spike findings (Task 0 output).
- `README.md` — install + usage + troubleshooting.

---

## Task 0: Spike — determine injection & filter mechanism

**Purpose:** Resolve R4 (transform hook has empty `input`, cannot see the agent) and R5 (`config.skills.paths` untyped) before writing real code. This task produces a written findings doc, not shipped code.

**Files:**
- Create (throwaway): `/tmp/opencode/spike-orchestrate/.opencode/plugins/spike.js`
- Create (throwaway): `/tmp/opencode/spike-orchestrate/opencode.json`
- Create (committed): `docs/spikes/2026-06-18-transform-hook.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a decision recorded in `docs/spikes/2026-06-18-transform-hook.md` with these named answers used by later tasks:
  - `INJECT_FILTER_STRATEGY`: one of `"inject-everywhere"`, `"sessionid-correlation"`, `"prompt-self-skip"`.
  - `SKILLS_PATHS_WORKS`: boolean — whether `config.skills.paths.push(dir)` registers a bundled skill.
  - `MESSAGES_TRANSFORM_SHAPE`: the observed real shape of `output.messages` (confirm `info.role`, `parts[].type === "text"`, `parts[].text`).

- [ ] **Step 1: Create the throwaway spike workspace and config**

Create `/tmp/opencode/spike-orchestrate/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": { "*": { "*": "allow" } }
}
```

- [ ] **Step 2: Write the spike plugin that logs hook payloads**

Create `/tmp/opencode/spike-orchestrate/.opencode/plugins/spike.js`:

```js
import fs from "node:fs";
import path from "node:path";

const LOG = "/tmp/opencode/spike-orchestrate/spike.log";
const log = (label, obj) => {
  fs.appendFileSync(
    LOG,
    `\n=== ${label} ===\n${JSON.stringify(obj, (_k, v) => (typeof v === "string" && v.length > 300 ? v.slice(0, 300) + "…" : v), 2)}\n`,
  );
};

export const SpikePlugin = async ({ client }) => {
  return {
    config: async (config) => {
      const skillsDir = path.join(import.meta.dirname, "spike-skill");
      try {
        const cfg = /** @type {any} */ (config);
        cfg.skills = cfg.skills || {};
        cfg.skills.paths = cfg.skills.paths || [];
        cfg.skills.paths.push(skillsDir);
        log("config.skills.paths.after", cfg.skills.paths);
      } catch (e) {
        log("config.skills.error", String(e));
      }
      log("config.agent.keys", Object.keys(config.agent || {}));
    },
    "chat.message": async (input) => {
      log("chat.message.input", input);
    },
    "experimental.chat.messages.transform": async (input, output) => {
      log("transform.input", input);
      log("transform.messages.summary", (output.messages || []).map((m) => ({
        role: m?.info?.role,
        partTypes: (m?.parts || []).map((p) => p?.type),
      })));
    },
  };
};

export default { server: SpikePlugin };
```

- [ ] **Step 3: Run opencode in the spike workspace and exercise it**

Run a short interactive or `run` session so the hooks fire, e.g.:

```bash
cd /tmp/opencode/spike-orchestrate && opencode run "say hello" 2>&1 | tail -5
```

Expected: `/tmp/opencode/spike-orchestrate/spike.log` is created and contains `config.*`, `chat.message.input`, and `transform.*` entries.

- [ ] **Step 4: Inspect the log and answer the three questions**

Read `/tmp/opencode/spike-orchestrate/spike.log`. Determine:
1. Does `transform.input` contain any `sessionID`/`agent`? (Expected: no — confirms R4.)
2. Does `chat.message.input` contain `agent` and `sessionID`? (Expected: yes.)
3. Did adding `spike-skill` to `config.skills.paths` produce no error and (if a `spike-skill/SKILL.md` existed) get discovered? Note `SKILLS_PATHS_WORKS`.
4. Real shape of `output.messages[].info.role` and `parts[].type`.

Decide `INJECT_FILTER_STRATEGY`:
- If `chat.message` reliably precedes `transform` per turn and you can correlate, pick `"sessionid-correlation"` only if `transform` exposes a correlatable id; since `transform.input` is `{}`, the realistic outcomes are `"inject-everywhere"` (default, simplest) or `"prompt-self-skip"`.
- Default to `"inject-everywhere"` unless the log shows subagent sessions also pass through `transform` with a usable correlation handle.

- [ ] **Step 5: Write the findings doc**

Create `docs/spikes/2026-06-18-transform-hook.md` containing the three named answers (`INJECT_FILTER_STRATEGY`, `SKILLS_PATHS_WORKS`, `MESSAGES_TRANSFORM_SHAPE`) and a 3-5 line rationale. This doc is the authority for Task 6.

- [ ] **Step 6: Commit the findings doc**

```bash
cd /home/alex/Projects/opencode-orchestrate
git add docs/spikes/2026-06-18-transform-hook.md
git commit -m "spike: determine transform-hook injection and filter mechanism"
```

---

## Task 1: Package skeleton

**Files:**
- Create: `package.json`
- Create: `LICENSE`
- Modify: `.gitignore` (ensure `node_modules/` present — already is)
- Create: `.github/workflows/test.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: `bun test` runs (with zero tests, exits 0); `main` points at the plugin path used by Task 6.

- [ ] **Step 1: Write package.json**

Create `package.json`:

```json
{
  "name": "opencode-orchestrate",
  "version": "0.1.0",
  "description": "OpenCode plugin that turns the build agent into a PDCA orchestrator over worker/reviewer subagents",
  "type": "module",
  "main": ".opencode/plugins/orchestrate.js",
  "scripts": {
    "test": "bun test"
  },
  "keywords": [
    "opencode",
    "opencode-plugin",
    "orchestrator",
    "pdca",
    "subagents"
  ],
  "author": "AlexMKX",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/AlexMKX/opencode-orchestrate.git"
  },
  "peerDependencies": {
    "@opencode-ai/plugin": "^1.4.0"
  },
  "devDependencies": {
    "@opencode-ai/plugin": "^1.15.10",
    "@opencode-ai/sdk": "^1.15.0",
    "@types/bun": "latest"
  }
}
```

- [ ] **Step 2: Write the MIT LICENSE**

Create `LICENSE` with the standard MIT License text, copyright line `Copyright (c) 2026 AlexMKX`.

- [ ] **Step 3: Write the CI workflow**

Create `.github/workflows/test.yml`:

```yaml
name: test
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun test
```

- [ ] **Step 4: Install deps and verify the test runner works**

Run:

```bash
cd /home/alex/Projects/opencode-orchestrate && bun install && bun test
```

Expected: install succeeds; `bun test` reports `0 tests` (or "no tests found") and exits 0.

- [ ] **Step 5: Commit**

```bash
cd /home/alex/Projects/opencode-orchestrate
git add package.json LICENSE .github/workflows/test.yml bun.lock .gitignore
git commit -m "chore: package skeleton with bun test CI"
```

---

## Task 2: Inventory formatter (`src/inventory.js`)

**Files:**
- Create: `src/inventory.js`
- Test: `tests/inventory.test.js`

**Interfaces:**
- Consumes: an array of `Agent` objects (shape per Global Constraints).
- Produces: `formatInventory(agents: Agent[]): string` — a markdown bullet list of subagents only (`mode === "subagent"`), each line `- \`<name>\`: <description> (model: <providerID/modelID or "inherited">)`. Returns the literal string `"(no subagents available)"` when there are zero subagents. Used by Task 6.

- [ ] **Step 1: Write the failing test**

Create `tests/inventory.test.js`:

```js
import { test, expect } from "bun:test";
import { formatInventory } from "../src/inventory.js";

test("lists only subagents with name, description, model", () => {
  const agents = [
    { name: "build", mode: "primary", builtIn: true },
    {
      name: "worker",
      mode: "subagent",
      builtIn: false,
      description: "Generic executor",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    },
    {
      name: "explore",
      mode: "subagent",
      builtIn: true,
      description: "Read-only explorer",
    },
  ];
  const out = formatInventory(agents);
  expect(out).toContain("- `worker`: Generic executor (model: anthropic/claude-sonnet-4-6)");
  expect(out).toContain("- `explore`: Read-only explorer (model: inherited)");
  expect(out).not.toContain("build");
});

test("returns placeholder when no subagents", () => {
  expect(formatInventory([{ name: "build", mode: "primary", builtIn: true }]))
    .toBe("(no subagents available)");
});

test("handles missing description", () => {
  const out = formatInventory([
    { name: "x", mode: "subagent", builtIn: false },
  ]);
  expect(out).toContain("- `x`: (no description) (model: inherited)");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/alex/Projects/opencode-orchestrate && bun test tests/inventory.test.js`
Expected: FAIL — cannot find module `../src/inventory.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/inventory.js`:

```js
// Pure formatting of the subagent inventory for the orchestrator bootstrap.

/**
 * @param {Array<{name:string,mode:string,description?:string,model?:{providerID:string,modelID:string}}>} agents
 * @returns {string}
 */
export function formatInventory(agents) {
  const subagents = (agents || []).filter((a) => a && a.mode === "subagent");
  if (subagents.length === 0) return "(no subagents available)";
  return subagents
    .map((a) => {
      const desc = a.description || "(no description)";
      const model = a.model
        ? `${a.model.providerID}/${a.model.modelID}`
        : "inherited";
      return `- \`${a.name}\`: ${desc} (model: ${model})`;
    })
    .join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/alex/Projects/opencode-orchestrate && bun test tests/inventory.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/alex/Projects/opencode-orchestrate
git add src/inventory.js tests/inventory.test.js
git commit -m "feat: subagent inventory formatter"
```

---

## Task 3: Bootstrap assembler (`src/bootstrap.js`)

**Files:**
- Create: `src/bootstrap.js`
- Test: `tests/bootstrap.test.js`

**Interfaces:**
- Consumes: `inventoryMarkdown: string` (output of `formatInventory`).
- Produces: `buildBootstrap(inventoryMarkdown: string): string` and the exported constant `BOOTSTRAP_MARKER: string`. The returned block starts with `BOOTSTRAP_MARKER`, embeds the inventory, and contains the short delegate-trigger and a pointer to the `orchestrating-subagents` skill. Used by Task 6 (which also uses `BOOTSTRAP_MARKER` as the double-injection guard).

- [ ] **Step 1: Write the failing test**

Create `tests/bootstrap.test.js`:

```js
import { test, expect } from "bun:test";
import { buildBootstrap, BOOTSTRAP_MARKER } from "../src/bootstrap.js";

test("block starts with the marker and embeds inventory", () => {
  const inv = "- `worker`: Generic executor (model: anthropic/claude-sonnet-4-6)";
  const out = buildBootstrap(inv);
  expect(out.startsWith(BOOTSTRAP_MARKER)).toBe(true);
  expect(out).toContain(inv);
});

test("mentions the delegation decision and the skill name", () => {
  const out = buildBootstrap("(no subagents available)");
  expect(out.toLowerCase()).toContain("delegate");
  expect(out).toContain("orchestrating-subagents");
});

test("marker is a stable non-empty string", () => {
  expect(typeof BOOTSTRAP_MARKER).toBe("string");
  expect(BOOTSTRAP_MARKER.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/alex/Projects/opencode-orchestrate && bun test tests/bootstrap.test.js`
Expected: FAIL — cannot find module `../src/bootstrap.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/bootstrap.js`:

```js
// Assembles the hidden orchestrator bootstrap block injected into the first
// user message. Kept lightweight: heavy PDCA logic lives in the skill.

export const BOOTSTRAP_MARKER = "<ORCHESTRATE_BOOTSTRAP>";

/**
 * @param {string} inventoryMarkdown
 * @returns {string}
 */
export function buildBootstrap(inventoryMarkdown) {
  return `${BOOTSTRAP_MARKER}
You are an orchestrator.

Before acting on a request, make one decision: **do it yourself, or delegate?**
- If the user said "do it yourself", or the task is a single trivial action, do it yourself.
- Otherwise consider delegating to a subagent and running a PDCA cycle
  (worker executes → work-reviewer reviews → you route the verdict).

For the full delegation workflow, contracts, iteration cap, and routing rules,
load the \`orchestrating-subagents\` skill when you decide to delegate.

## Available subagents
${inventoryMarkdown}
</ORCHESTRATE_BOOTSTRAP>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/alex/Projects/opencode-orchestrate && bun test tests/bootstrap.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/alex/Projects/opencode-orchestrate
git add src/bootstrap.js tests/bootstrap.test.js
git commit -m "feat: orchestrator bootstrap assembler"
```

---

## Task 4: Agent prompts (static files)

**Files:**
- Create: `prompts/worker.md`
- Create: `prompts/work-reviewer.md`

**Interfaces:**
- Consumes: nothing.
- Produces: two prompt files read by Task 5 (`src/agents.js`). Their exact relative paths (`prompts/worker.md`, `prompts/work-reviewer.md`) are the contract.

- [ ] **Step 1: Write the worker prompt**

Create `prompts/worker.md`:

```markdown
You are a worker subagent in an orchestrator-driven PDCA cycle.

You receive from the orchestrator:
- a task brief,
- a free-form definition of done,
- relevant context,
- (on a retry) previous review feedback.

Do the work. Stay strictly within the brief — do not add unrequested scope.
Use any globally available skills (e.g. TDD, systematic-debugging) as appropriate
inside your own session.

Return:
- the concrete artifacts produced (for code: the list of changed/created file
  paths; for other work: the deliverable itself or where it lives),
- a concise summary of what you did and why,
- an explicit list of anything you could NOT do and why.

If you cannot proceed because you lack access or information, say so plainly
instead of guessing.
```

- [ ] **Step 2: Write the reviewer prompt**

Create `prompts/work-reviewer.md`:

```markdown
You are a reviewer subagent in an orchestrator-driven PDCA cycle.

You receive: the task brief, the free-form definition of done, and the worker's
result.

Read the actual artifacts yourself — do NOT trust the worker's word. Break the
definition of done into concrete checkable items and verify each against reality.
Use globally available review skills (e.g. receiving-code-review,
verification-before-completion) as appropriate.

Return STRICT JSON ONLY — no prose, no markdown fences:
{
  "verdict": "PASS" | "FAIL",
  "checks": [{"check": "<derived from DoD>", "met": true, "evidence": "<what you saw>"}],
  "issues": [{"severity": "high" | "med" | "low", "description": "..."}],
  "suggested_fixes": ["..."],
  "blocking": true
}

Set "verdict" to "PASS" only when every check is met. "blocking" is true when at
least one high-severity issue prevents acceptance.
```

- [ ] **Step 3: Commit**

```bash
cd /home/alex/Projects/opencode-orchestrate
git add prompts/worker.md prompts/work-reviewer.md
git commit -m "feat: worker and reviewer prompts"
```

---

## Task 5: Agent definitions (`src/agents.js`)

**Files:**
- Create: `src/agents.js`
- Test: `tests/agents.test.js`

**Interfaces:**
- Consumes: `prompts/worker.md`, `prompts/work-reviewer.md` (from Task 4); the verified `AgentConfig` shape.
- Produces: `agentDefinitions(promptsDir: string): { worker: AgentConfig, "work-reviewer": AgentConfig }`. Each AgentConfig has `mode: "subagent"`, `hidden: true`, `model: "anthropic/claude-sonnet-4-6"`, a `description`, the `prompt` read from the corresponding file, and `permission`. `worker` permission: `{ edit: "allow", bash: "allow", task: { "*": "deny" } }`. `work-reviewer` permission: `{ edit: "deny", bash: "deny", webfetch: "allow", task: { "*": "deny" } }`. Used by Task 6.

- [ ] **Step 1: Write the failing test**

Create `tests/agents.test.js`:

```js
import { test, expect } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentDefinitions } from "../src/agents.js";

const promptsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "prompts",
);

test("defines worker and work-reviewer subagents", () => {
  const defs = agentDefinitions(promptsDir);
  expect(Object.keys(defs).sort()).toEqual(["work-reviewer", "worker"]);
});

test("worker can edit and run bash but cannot spawn tasks", () => {
  const { worker } = agentDefinitions(promptsDir);
  expect(worker.mode).toBe("subagent");
  expect(worker.hidden).toBe(true);
  expect(worker.model).toBe("anthropic/claude-sonnet-4-6");
  expect(worker.permission.edit).toBe("allow");
  expect(worker.permission.bash).toBe("allow");
  expect(worker.permission.task["*"]).toBe("deny");
  expect(worker.prompt.length).toBeGreaterThan(20);
});

test("reviewer is read-only and cannot spawn tasks", () => {
  const reviewer = agentDefinitions(promptsDir)["work-reviewer"];
  expect(reviewer.permission.edit).toBe("deny");
  expect(reviewer.permission.bash).toBe("deny");
  expect(reviewer.permission.task["*"]).toBe("deny");
  expect(reviewer.prompt).toContain("STRICT JSON");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/alex/Projects/opencode-orchestrate && bun test tests/agents.test.js`
Expected: FAIL — cannot find module `../src/agents.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/agents.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/alex/Projects/opencode-orchestrate && bun test tests/agents.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/alex/Projects/opencode-orchestrate
git add src/agents.js tests/agents.test.js
git commit -m "feat: programmatic worker and reviewer agent definitions"
```

---

## Task 6: Plugin entry (`.opencode/plugins/orchestrate.js`)

**Files:**
- Create: `.opencode/plugins/orchestrate.js`
- Read for guidance: `docs/spikes/2026-06-18-transform-hook.md` (Task 0)

**Interfaces:**
- Consumes: `agentDefinitions` (Task 5), `formatInventory` (Task 2), `buildBootstrap` + `BOOTSTRAP_MARKER` (Task 3), `client.app.agents()` (SDK), and `INJECT_FILTER_STRATEGY`/`SKILLS_PATHS_WORKS` from the spike doc.
- Produces: the plugin module. No further task consumes it (it is the top of the dependency tree).

- [ ] **Step 1: Read the spike findings**

Read `docs/spikes/2026-06-18-transform-hook.md`. Note `INJECT_FILTER_STRATEGY` and `SKILLS_PATHS_WORKS`. The implementation below assumes `INJECT_FILTER_STRATEGY === "inject-everywhere"` and `SKILLS_PATHS_WORKS === true`. If the spike concluded otherwise, adjust per the doc's rationale (see Step 4 note) before committing.

- [ ] **Step 2: Write the plugin**

Create `.opencode/plugins/orchestrate.js`:

```js
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
      const bootstrap = await getBootstrap();
      if (!output.messages || output.messages.length === 0) return;
      const firstUser = output.messages.find((m) => m?.info?.role === "user");
      if (!firstUser || !firstUser.parts || firstUser.parts.length === 0) return;

      // Guard against double injection.
      if (
        firstUser.parts.some(
          (p) => p?.type === "text" && p.text && p.text.includes(BOOTSTRAP_MARKER),
        )
      ) {
        return;
      }

      const ref = firstUser.parts[0];
      firstUser.parts.unshift({ ...ref, type: "text", text: bootstrap });
    },
  };
};

export default { server: OrchestratePlugin };
```

- [ ] **Step 3: Verify the package still loads and tests pass**

Run: `cd /home/alex/Projects/opencode-orchestrate && bun test`
Expected: PASS (all unit tests from Tasks 2/3/5 still green; the plugin file has no unit test but must parse — confirm no import/syntax error by also running `bun build .opencode/plugins/orchestrate.js --target node > /dev/null` and expecting exit 0).

- [ ] **Step 4: Adapt filter strategy if the spike said so**

If `INJECT_FILTER_STRATEGY !== "inject-everywhere"`: implement the chosen mechanism per the spike doc (e.g. add a `chat.message` hook that records `sessionID → agent` and skip injection for known subagent sessions). If `SKILLS_PATHS_WORKS === false`: replace the skills registration with the fallback recorded in the spike doc (e.g. one-time idempotent copy of `SKILLS_DIR` into the global skills dir). Keep the change minimal and documented with a code comment referencing the spike.

- [ ] **Step 5: Commit**

```bash
cd /home/alex/Projects/opencode-orchestrate
git add .opencode/plugins/orchestrate.js
git commit -m "feat: plugin entry wiring config and bootstrap hooks"
```

---

## Task 7: Orchestrating-subagents skill

**Files:**
- Create: `skills/orchestrating-subagents/SKILL.md`

**Interfaces:**
- Consumes: nothing at runtime (static doc). Its `name` frontmatter must equal the folder name `orchestrating-subagents` and is referenced by `src/bootstrap.js` (Task 3).
- Produces: the on-demand PDCA workflow guidance.

- [ ] **Step 1: Write the skill**

Create `skills/orchestrating-subagents/SKILL.md`:

```markdown
---
name: orchestrating-subagents
description: Use when deciding whether to delegate a user's task to subagents and how to run the worker/reviewer PDCA cycle - covers the delegation decision, task-brief and definition-of-done contracts, verdict routing, the iteration cap, and the final sanity-check.
license: MIT
---

# Orchestrating Subagents (PDCA)

You are an orchestrator running a Deming/PDCA loop over subagents. This skill is
orthogonal to other skills: the worker and reviewer use their own skills inside
their own sessions. Your job is to decide, delegate, and route.

## 1. Decide: yourself or delegate?

Do it YOURSELF when:
- the user said "do it yourself", or
- the task is a single trivial action with no ambiguity, or
- it would take you fewer than ~3 steps. Do not orchestrate for its own sake —
  the cycle is expensive.

Otherwise DELEGATE.

When user-defined specialized subagents exist (see the injected inventory) and
one fits the task better than the generic `worker`, prefer it — but still route
its output through a reviewer.

## 2. Formulate the work

Before calling the worker, write:
- a **task brief** (what to do),
- a **definition of done** in free form: how you will know it was done well,
  tailored to the task domain (code, docs, research, creative, …),
- the relevant **context**,
- the **return format** you want.

## 3. The cycle (max 3 iterations)

For iteration N = 1..3:

1. Invoke `worker` (via the task tool) with: task brief, definition of done,
   context, return format, and — if N > 1 — the previous reviewer feedback.
2. If the worker returns empty/garbage, treat it as FAIL without calling the
   reviewer; retry with "previous attempt returned no usable output".
3. If the worker reports it lacks access/information, escalate to the user — do
   not auto-retry.
4. Otherwise invoke `work-reviewer` with: task brief, definition of done, and
   the worker's result verbatim. The reviewer returns strict JSON.
5. If the reviewer returns non-JSON, retry it once with "STRICT JSON ONLY". If
   it fails again, review the work yourself.

## 4. Route the verdict

- `verdict = PASS` → exit the loop, then run a **final sanity-check yourself**
  (a quick own check — e.g. run tests/lint if applicable — not another review).
  If your sanity-check finds problems the reviewer missed, fix them yourself and
  note it.
- `verdict = FAIL` and N < 3 → iteration N+1, passing the reviewer feedback to
  the worker.
- `verdict = FAIL` and N = 3 → stop and escalate to the user: show what exists
  and ask how to proceed.
- Two consecutive FAILs on the same fundamental blocker → take control: either
  finish it yourself or escalate. This signals the brief/DoD was poorly formed.

## 5. Escape hatches

You may abort the cycle at any point and finish the work yourself if delegation
turns out to be the wrong call mid-flight. Do not dogmatically complete the loop.

## 6. Transparency

In your final answer to the user, briefly state the delegation outcome, e.g.
"delegated to worker (2 iterations), reviewer approved".
```

- [ ] **Step 2: Verify frontmatter constraints**

Confirm: the folder is exactly `skills/orchestrating-subagents/`, `name` equals `orchestrating-subagents`, and `description` is ≤ 1024 characters.

Run:
```bash
cd /home/alex/Projects/opencode-orchestrate
awk '/^description:/{print length($0)}' skills/orchestrating-subagents/SKILL.md
```
Expected: a number well under 1024.

- [ ] **Step 3: Commit**

```bash
cd /home/alex/Projects/opencode-orchestrate
git add skills/orchestrating-subagents/SKILL.md
git commit -m "feat: orchestrating-subagents PDCA skill"
```

---

## Task 8: README and end-to-end manual smoke

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: the whole package.
- Produces: install + usage + troubleshooting docs; a verified end-to-end run.

- [ ] **Step 1: Write README.md**

Create `README.md` covering:
- One-line description.
- Install: add to `~/.config/opencode/opencode.json`:
  ```json
  { "plugin": ["opencode-orchestrate@git+https://github.com/AlexMKX/opencode-orchestrate.git"] }
  ```
- What you get: `worker` and `work-reviewer` subagents (hidden), the
  `orchestrating-subagents` skill, and a hidden bootstrap injected into the
  build agent.
- Optional model override example:
  ```json
  { "agent": { "worker": { "model": "anthropic/claude-sonnet-4-6" }, "work-reviewer": { "model": "anthropic/claude-haiku-4-5" } } }
  ```
- How the PDCA cycle works (short, link to the skill).
- Troubleshooting: how to confirm the plugin loaded, how to confirm subagents
  are registered (they are `hidden`, so mention they are invoked via the task
  tool, not the `@` menu), and the iteration cap / cost note.
- Development: `bun install`, `bun test`.
- License: MIT.

- [ ] **Step 2: Local install smoke test**

Install the package locally into a scratch opencode config via `git+file://` (or
a direct local path) and start a fresh session. Verify:
1. The plugin loads with no error in the opencode log.
2. `worker` and `work-reviewer` appear in `client.app.agents()` output (can be
   confirmed by a one-off `opencode run` that asks the model to list available
   subagents, or by inspecting the log).
3. Asking the orchestrator a non-trivial task causes it to invoke `worker` and
   then `work-reviewer`.

Record the smoke result (pass/fail + notes) in the commit message of Step 3. If
any check fails, fix the underlying task before committing.

- [ ] **Step 3: Commit**

```bash
cd /home/alex/Projects/opencode-orchestrate
git add README.md
git commit -m "docs: README with install, usage, troubleshooting; record smoke result"
```

---

## Self-Review Notes

- **Spec coverage:** §2 distribution → Task 1 + Task 8 README. §3.2 hooks → Task 6 (+ Task 0 spike for the filter caveat). §3.3 subagents → Tasks 4+5. §3.4 skill → Task 7. §4 PDCA contracts/routing → Task 7 skill body. §5 error handling → Task 7 skill body. §6 cost/cap → Task 7 + README. §7 superpowers coexistence → worker/reviewer prompts (Task 4) inherit global skills; no duplicate skills added. §9 F1/F2/F3 baked into Global Constraints; R2 → Task 6 "define only if not present"; R4/R5 → Task 0 spike. §10 YAGNI respected (no status tool, no planner, no persistence).
- **Type consistency:** `formatInventory` (Task 2) consumed by Task 6; `buildBootstrap`/`BOOTSTRAP_MARKER` (Task 3) consumed by Task 6; `agentDefinitions(promptsDir)` (Task 5) consumed by Task 6; prompt file paths (Task 4) consumed by Task 5. Names match across tasks.
- **Placeholders:** none — all code steps contain full code.
```
