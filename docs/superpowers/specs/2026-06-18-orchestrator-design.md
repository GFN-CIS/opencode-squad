# opencode-orchestrate — Design Spec

**Date:** 2026-06-18
**Status:** Approved (design phase)

## 1. Purpose

An OpenCode injector package, in the spirit of `superpowers`, that turns the
default `build` primary agent into an **orchestrator** running a Deming/PDCA
loop over subagents. It is an orthogonal layer: it sits *above* superpowers and
never conflicts with it.

The orchestrator (an expensive model, e.g. opus):

1. On every user input, decides whether to **do the work itself** or to
   **formulate/decompose the task and delegate** it to subagents — unless the
   user explicitly says "do it yourself".
2. When delegating, runs a PDCA cycle: `worker` executes → `work-reviewer`
   reviews → orchestrator routes the verdict → final sanity-check.
3. Sees a dynamic inventory of available subagents (not just the bundled two,
   but also user-defined ones like `implementer`, `code-reviewer`, etc.) and
   prefers a more specialized subagent when one fits the task better.

This is **generic** orchestration — it applies to any kind of work (code, docs,
research, analysis, creative), not just software development.

## 2. Distribution

- Published as an npm-style package, installed via `git+https://` (no npm
  registry publish), mirroring `opencode-time-logger`.
- User installs by adding one line to their `opencode.json`:

  ```json
  {
    "plugin": ["opencode-orchestrate@git+https://github.com/AlexMKX/opencode-orchestrate.git"]
  }
  ```

- The user prescribes **nothing else** by hand. Subagents and the skill are
  registered automatically by the plugin.
- The user **may optionally** override subagent models/permissions in their own
  `opencode.json` `agent` block (e.g. `agent.worker.model`); their config wins
  via OpenCode's config merge precedence.

## 3. Architecture

### 3.1 Components

```
opencode-orchestrate/
├── package.json              # main → .opencode/plugins/orchestrate.js, type=module
├── README.md
├── LICENSE                   # MIT
├── .gitignore
├── bun.lock
├── .github/workflows/test.yml
├── .opencode/
│   └── plugins/
│       └── orchestrate.js    # entry: config hook + messages.transform hook
├── prompts/                  # bundled agent prompts (NOT in chat-visible dirs)
│   ├── worker.md
│   └── work-reviewer.md
├── skills/
│   └── orchestrating-subagents/
│       └── SKILL.md          # PDCA workflow, loaded on-demand
├── src/
│   ├── inventory.js          # read subagent inventory via SDK
│   ├── bootstrap.js          # assemble hidden bootstrap block
│   └── agents.js             # worker + work-reviewer definitions as objects
└── tests/
    ├── bootstrap.test.js
    ├── inventory.test.js
    └── agents.test.js
```

### 3.2 Plugin entry (`.opencode/plugins/orchestrate.js`)

Exported as `export default { server: OrchestratePlugin }` (mirrors
`opencode-time-logger`, the canonical form for this ecosystem).

Two hooks:

**`config` hook** — registers bundled resources without touching any external
directory:

1. Pushes the bundled `skills/` directory onto `config.skills.paths` (proven
   pattern used by both superpowers and time-logger; not present in the typed
   `Config`, applied via an `any`-cast, runtime-verified).
2. Defines `config.agent.worker` and `config.agent["work-reviewer"]`
   **programmatically as objects** (`config.agent` is typed and accepts
   arbitrary keys → `AgentConfig`), but **only if the user has not already
   defined them** (user override wins). Agent prompts are read from `prompts/`
   via `fs.readFileSync` (not hardcoded in JS).

**`experimental.chat.messages.transform` hook** — injects a hidden, lightweight
bootstrap block into the **first user message** of an orchestrator session
(mirrors superpowers). The block is invisible in the chat UI and is **not**
repeated on every turn.

**Agent-filter caveat:** the `experimental.chat.messages.transform` hook
receives an **empty `input` ({})** — it carries no `sessionID` and no `agent`.
Therefore the exact mechanism to restrict injection to the `build`/orchestrator
agent (and skip `worker`/`work-reviewer` subagent sessions) is **not yet
known** and must be resolved by a spike (Task 0 of the plan) before any other
code is written. Candidate mechanisms: (a) inject everywhere and let the
subagents' own prompts dominate the orphan block; (b) correlate `sessionID` via
a companion `chat.message` hook; (c) a marker the subagents' prompts carry to
self-skip. The spike picks one based on observed runtime behavior.

The bootstrap block contains:
- A short trigger: "before acting, decide — do it yourself or delegate via the
  PDCA cycle?"
- A pointer to the `orchestrating-subagents` skill (heavy PDCA logic lives
  there, loaded on-demand — keeps bootstrap thin).
- The **dynamic subagent inventory** (name + description + mode/model per
  available subagent), read once per session via the SDK and cached at module
  level (mirrors superpowers' `_bootstrapCache`).

Guard: skip injection if the first user message already contains the bootstrap
marker (prevents double injection when the hook re-fires on already-transformed
message arrays).

The hook only injects for the `build` agent. Other agents/subagents are left
untouched.

### 3.3 Subagents (defined as objects in `src/agents.js`)

**`worker`**
- `mode: subagent`, `hidden: true`
- `model: anthropic/claude-sonnet-4-6` (default; user-overridable)
- permissions: `edit: allow`, `bash: allow`, `task: { "*": "deny" }`
  (task deny prevents uncontrolled nested orchestration / recursion)
- prompt (`prompts/worker.md`): a generic executor. Receives task brief +
  definition of done + optional previous review feedback. Executes, stays in
  scope, returns a structured result (list of changed files/artifacts +
  concise summary). May use superpowers skills (TDD, systematic-debugging)
  inside its own session.

**`work-reviewer`**
- `mode: subagent`, `hidden: true`
- `model: anthropic/claude-sonnet-4-6` (default; user-overridable)
- permissions: `edit: deny`, `bash: deny`, `read/grep/glob/lsp/webfetch: allow`,
  `task: { "*": "deny" }`
- prompt (`prompts/work-reviewer.md`): a generic reviewer. Receives task brief +
  definition of done + worker's result. Reads actual artifacts (does not trust
  the worker's word). Uses `receiving-code-review` and
  `verification-before-completion` skills. Returns **strict JSON only**.

### 3.4 Skill (`skills/orchestrating-subagents/SKILL.md`)

Frontmatter strictly per OpenCode docs (only `name`, `description`, optional
`license`/`compatibility`/`metadata`). `name` matches the folder name
(`orchestrating-subagents`, regex `^[a-z0-9]+(-[a-z0-9]+)*$`), `description`
≤ 1024 chars.

Body covers:
- When to delegate vs do it yourself (decision tree).
- How to write a task brief and a free-form definition of done.
- The worker / reviewer invocation contracts (§4).
- Verdict routing (§4.3).
- Hard cap of 3 iterations.
- Final sanity-check after PASS.
- Preferring user-defined specialized subagents when they fit better.
- Escape hatches (the orchestrator may abort the cycle at any time).
- Transparency to the user (state delegation in the final answer).

## 4. PDCA Dataflow

```
User message
   ↓
Orchestrator (build, opus) reads injected bootstrap → sees PDCA trigger +
subagent inventory.
Decision:
   ├─ "DO IT YOURSELF" in prompt?  → do it, done.
   ├─ Trivial (single action, no ambiguity)? → do it.
   └─ Otherwise → DELEGATE (formulate task brief + definition of done)
   ↓
Iteration N (N = 1..3):
   Worker (sonnet): brief + DoD + (previous review feedback if N>1) → result
   ↓
   Reviewer (sonnet, read-only): brief + DoD + worker result → strict JSON
   ↓
   Orchestrator routing:
      verdict=PASS         → exit loop → final sanity-check
      verdict=FAIL, N<3    → iteration N+1 (pass reviewer feedback to worker)
      verdict=FAIL, N=3    → escalate to user (show state, ask how to proceed)
      fundamental DoD flaw → switch to self-do (orchestrator finishes itself)
   ↓
Final sanity-check (orchestrator itself): quick smoke (e.g. run tests/lint if
applicable) → answer the user, noting the delegation summary.
```

### 4.1 Definition of done (generic, free-form)

The orchestrator answers "how will we know the worker succeeded?" in free form,
tailored to the task domain. Examples:
- dev: "tests pass, lint clean, edge-case X covered"
- docs: "Install/Usage/Troubleshooting present, examples runnable, consistent
  with the code"
- research: "≥3 sources, dates cited, contradictions flagged"
- creative: "3 variants, each within N words, distinct styles"

The reviewer breaks the free-form DoD into checkable items itself.

### 4.2 Contracts

**Orchestrator → Worker** (`task` tool):
```
## Task brief
<what to do>

## Definition of done
<free-form: how we know it's done well, orchestrator-authored>

## Context
<relevant material, files, links, constraints>

## Previous review feedback (only if N>1)
<issues + suggested_fixes from reviewer>

## Return format
<orchestrator hints the desired artifact shape: files / links /
 markdown doc / variants with rationale / etc>
```

**Worker → Orchestrator** (text): list of changed/created files with paths,
concise summary, explicit list of anything not done.

**Orchestrator → Reviewer** (`task` tool):
```
## Task brief, definition of done, context
<same that the worker received>

## Worker result
<worker's answer verbatim>

## Your job
Read the actual artifacts (do not trust the worker on its word).
Break the DoD into checkable items and check each.
Run verification-before-completion mentally.

## Return format (STRICT JSON, no prose)
{ "verdict": "PASS"|"FAIL",
  "checks": [{"check": "...", "met": true, "evidence": "..."}],
  "issues": [{"severity": "high|med|low", "description": "..."}],
  "suggested_fixes": [...],
  "blocking": bool }
```

**Reviewer → Orchestrator**: the strict JSON above (orchestrator parses it).

### 4.3 Verdict routing

- `PASS` → exit loop, then a mandatory orchestrator final sanity-check (quick
  own check, not another review iteration).
- `FAIL` & N<3 → iteration N+1, passing reviewer feedback to the worker.
- `FAIL` & N=3 → escalate to user.
- Two consecutive FAILs on the same fundamental blocker → switch to self-do
  (signals the DoD/brief was poorly formed for an LLM executor).

## 5. Error Handling & Edge Cases

| Case | Behavior |
|---|---|
| Worker returns empty/garbage | Treat as FAIL without calling reviewer (save cost). N += 1, retry with "previous attempt returned no usable output". |
| Worker says "can't, need access to X" | Escalate to user with the concrete request. No auto-retry. |
| Worker error/timeout from task tool | 1 retry, then escalate. |
| Worker out of scope | Reviewer flags it; next iteration says "stay within scope". |
| Reviewer returns non-JSON | 1 retry with "STRICT JSON ONLY". If it fails again, orchestrator reviews itself. |
| Reviewer PASS but final sanity-check finds problems | Orchestrator fixes it itself (no new worker iteration), logs "reviewer missed: ...". |
| Reviewer stuck in "all critical" | After iteration 2 with identical blockers, orchestrator takes control (self-do or escalate). |
| Delegate decision wrong mid-flight | Orchestrator may abort the cycle and finish itself (escape hatch). |
| User interrupt (Ctrl+C) | OpenCode handles it; no state outside chat. On resume the orchestrator re-reads its own chat history and re-evaluates. No locks/queues/watchdogs. |
| Bundled subagents missing (both) | Bootstrap notes "subagents not found, falling back to single-agent mode". Do not break the session. |
| Only one subagent present | Degraded mode: worker without reviewer (rely on final sanity-check), or disable orchestration if only reviewer is present. |
| User-defined subagents in inventory | Orchestrator sees them and prefers a more specialized one when it fits, but still routes through a reviewer. |
| Nested orchestration | Prevented by default via `worker.permission.task: deny` and reviewer having no task tool. User may relax. |

## 6. Cost & Limits

- Hard cap of 3 iterations ≈ ~7 LLM calls per task
  (1 orchestrator decision + 3×(worker+reviewer) + final sanity-check).
- This is expensive. The skill states explicitly: if a task takes you fewer
  than 3 steps, do it yourself — do not orchestrate for the sake of it.
- Transparency: the orchestrator's final answer briefly states
  "delegated to worker (2 iterations), reviewer approved".

## 7. Coexistence with superpowers

Orthogonal layer. Our bootstrap is injected as its own block and does not
replace or interfere with superpowers' bootstrap. Worker/reviewer inherit
global skills, so they use superpowers (TDD, systematic-debugging,
receiving-code-review, verification-before-completion) **inside their own
sessions**. We add no duplicate skills.

## 8. Implementation Plan

1. Skeleton: `package.json` (main, type=module, peerDeps `@opencode-ai/plugin`,
   devDeps `@opencode-ai/sdk`), `README.md`, `LICENSE`, `.gitignore`, CI
   workflow (adapted from time-logger).
2. `src/bootstrap.js` + test: assemble the bootstrap text from a template.
3. `src/inventory.js` + test: read the subagent list via SDK, filter
   hidden/system entries, format for injection.
4. `src/agents.js` + test: worker + work-reviewer definition objects; prompts
   loaded from `prompts/`.
5. `prompts/worker.md`, `prompts/work-reviewer.md` — static prompts.
6. `skills/orchestrating-subagents/SKILL.md` — content-heavy, final.
7. `.opencode/plugins/orchestrate.js` — wire the two hooks together.
8. `README.md` — install instructions, optional model overrides, troubleshooting
   (verify plugin loaded, verify subagents visible).
9. Manual smoke: install locally via `git+file://`, verify bootstrap injects in
   a fresh session and worker/reviewer get invoked.

## 9. Verified API Facts & Open Risks

Resolved against `@opencode-ai/plugin@1.15.10` and `@opencode-ai/sdk` type
definitions:

- **F1 — Agent inventory API:** `client.app.agents()` returns `{ data: Agent[] }`.
  `Agent = { name, description?, mode: "subagent"|"primary"|"all", builtIn,
  permission, model?: {modelID, providerID}, prompt?, tools }`. Subagents are
  filtered by `mode === "subagent"`. (Resolves former R3.)
- **F2 — Programmatic agent definition:** the `config` hook receives the typed
  `Config`; `config.agent` is `{ [key: string]: AgentConfig }`. `AgentConfig`
  has `model?, prompt?, tools?, description?, mode?, permission?` plus an index
  signature, so `hidden` and `permission.task` are accepted. Defining
  `config.agent.worker = {...}` is type-valid. (Resolves former R1.)
- **F3 — Hooks:** `config?: (input: Config) => Promise<void>` and
  `"experimental.chat.messages.transform"?: (input: {}, output: { messages:
  { info: Message; parts: Part[] }[] }) => Promise<void>` both exist.

Open risks:

- **R2 — User override precedence.** Confirm that a user-defined
  `agent.worker` in their `opencode.json` wins over the plugin-defined default.
  Guard with "define only if not already present".
- **R4 — Agent filter in `messages.transform`.** The hook's `input` is `{}`
  (no `sessionID`, no `agent`), so restricting injection to the orchestrator
  agent is not directly possible inside the hook. **Resolved by a spike
  (Task 0)** that logs real hook payloads on a live session and picks the
  injection/filter mechanism before any other code is written.
- **R5 — `config.skills.paths` is untyped.** It is used by superpowers and
  time-logger via an `any`-cast but is absent from the typed `Config`. The
  spike (Task 0) also verifies that pushing onto `config.skills.paths` actually
  registers the bundled skill.

## 10. Out of Scope (YAGNI)

- No hard-coded router in the plugin (the orchestrator LLM decides).
- No `planner` subagent (opus plans itself).
- No `orchestrate_status` tool in MVP (orchestrator tracks iterations via its
  own context).
- No cross-session persistence, metrics, or telemetry.
- No custom IPC between subagents beyond the standard `task` tool.
- No "learning from past review failures".
- No specialized worker-coder / reviewer-security variants at launch.
- No parallel iterations within the PDCA cycle.
