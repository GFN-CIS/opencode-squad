# opencode-squad

An OpenCode plugin that turns the built-in `build` agent into a PDCA orchestrator. On every request it states an explicit `SELF`/`DELEGATE` verdict: trivial work it does itself; real work it hands to a `grunt` subagent — routing changes through a `drill` (the Deming check), and investigations straight back to itself. A live context-usage signal feeds the decision so a heavy task isn't burned into an already-full context.

---

## Install

Add one line to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-squad@git+https://github.com/GFN-CIS/opencode-squad.git"]
}
```

That is all. On next start, OpenCode registers everything automatically.

---

## What you get

| Component | Type | Notes |
|---|---|---|
| `grunt` | hidden subagent | Executes delegated tasks |
| `drill` | hidden subagent | Reviews grunt output, returns a strict JSON verdict |
| `squad-delegate` | skill | The orchestrator's delegation protocol — loaded on demand when it decides to delegate (shapes, PDCA, risk gate) |
| `squad-stall` | skill | The orchestrator's stall-breaking ladder — loaded on demand when it recognizes it's stuck (kept separate so a stall doesn't pull in the whole delegation protocol) |
| `squad-draft-grunts` | skill | Drafts the per-model grunt roster — discovers available models, proposes a tiered set, asks what to add/remove, then generates one hidden `grunt-<provider>-<model>` each, giving the orchestrator a menu of models to delegate to |
| Bootstrap | hidden injection | Injected into the first user message of the `build` agent; sets the orchestrator role and selection rules, the current local time, the orchestrator's own model, and an inventory of subagents (each with its model) |
| Context signal | hidden injection | A live `<ORCHESTRATE_CONTEXT>` line added to the latest user message each turn, reporting current context usage so the orchestrator can weigh it in the decision |

The bootstrap carries live session facts resolved at injection time — the current local time (with timezone) and the model the orchestrator is actually running on (so an Opus session does not mistake itself for Sonnet). Each subagent in the inventory is listed with its model, so the orchestrator can match work to capability.

"Hidden" means the subagents are registered but do not appear in the `@` mention menu. The orchestrator invokes them programmatically via the task tool. Both injections target **only the `build` agent's own sessions** — grunt/drill subagent sessions are never injected into, so there is no recursion.

---

## Optional: override subagent models

The default model for both subagents is `anthropic/claude-sonnet-4-6`. To use a different model for either subagent, add an `agent` block to your `opencode.json`:

```json
{
  "plugin": ["opencode-squad@git+https://github.com/GFN-CIS/opencode-squad.git"],
  "agent": {
    "grunt": { "model": "anthropic/claude-sonnet-4-6" },
    "drill": { "model": "anthropic/claude-haiku-4-5" }
  }
}
```

Your `agent` block wins; anything you do not specify falls back to the default.

---

## Per-model grunts

opencode's `task` tool takes only `subagent_type` (no model), so the only way to let the orchestrator *choose* a model is to have one named grunt agent per model. The `squad-draft-grunts` skill sets this up interactively: invoke it and it discovers the available models (`opencode models`), proposes a tiered roster, asks what to add or remove, then — on your OK — writes one hidden grunt agent per model into `~/.config/opencode/agent/`.

```
anthropic/claude-opus-4-7   →  grunt-anthropic-claude-opus-4-7
openai/gpt-5.5              →  grunt-openai-gpt-5-5
google/gemini-3.5-flash     →  grunt-google-gemini-3-5-flash
```

Each generated grunt shares the bundled grunt prompt and permissions, differs only in `model`, and is `hidden` (dispatched by the orchestrator via `task`, not shown in the `@`-menu). They appear in the orchestrator's inventory **with their models**, which is what makes the capability-matching rule concrete — it can route analysis/architecture to a strong model and mechanical work to a cheap one. Re-running syncs the set (prunes generated grunts no longer listed; never touches hand-authored agents). Reload opencode to pick up new agents. The generic `grunt` / `drill` remain as the default.

---

## How it works

On **every** request the orchestrator must state one explicit verdict before acting — `SELF: <reason>` or `DELEGATE: <reason>`. This is the core mechanic: it forces a conscious choice instead of silently doing the work itself (the failure mode this plugin was built to fix). The default leans toward delegating — an expensive primary model's value is decomposition and review, not routine work.

### Selection principles

The orchestrator picks **DELEGATE** when *any* signal is present (this is the default for real work):

- **External access** — the task needs ssh, kubectl, grafana, the web, or a repo-wide search.
- **Depth** — it would take more than ~3 tool steps.
- **Artifact** — it produces code, docs, or config.
- **Heavy I/O** — it would ingest or generate a lot of raw material when you only need a summary (offload it, keep the orchestrator's context clean).
- **Context pressure** — the fuller the orchestrator's own context already is, the more a heavy task should be delegated rather than burned into it. A live `<ORCHESTRATE_CONTEXT>` line (e.g. `~120k / 1000k (12%)`) reports the current size each turn so this is a real number, not a guess.

It picks **SELF** only for: pure Q&A / explanation, a single trivial read, or when you explicitly told it to.

### Delegation shapes

Once it delegates, the shape depends on the task:

- **Read-only / investigation** (status checks, "why is X", log/metric digs) → delegate execution to `grunt` (or a specialized read agent like `Explore`) with **no drill** — there is no artifact to review. The orchestrator sanity-checks the findings itself, then reports.
- **Changes** (code / docs / config) → the full PDCA loop:
  1. **Plan / Do** — calls `grunt` with the brief, definition of done, context, and (from iteration 2 onward) the drill's feedback.
  2. **Check** — calls `drill` with the brief and the grunt's output. The drill returns a strict JSON verdict: `{"verdict": "PASS"|"FAIL", "checks": [...], "issues": [...], "suggested_fixes": [...], "blocking": <bool>}`.
  3. **Act** — on `PASS`, the orchestrator runs a final sanity-check (e.g. tests/lint) and delivers the result. On `FAIL`, it retries — up to **3 iterations total**, then escalates to the user rather than retrying blindly.

### Matching the delegate (capability & risk)

Delegating only helps if the delegate is actually fit for the task. The injected inventory lists each subagent's model, and the orchestrator weighs two things before handing work over:

- **Capability** — the orchestrator routes by what the *specific* models involved are good and bad at as of the current date (its own model and each subagent's model are in the bootstrap/inventory), rather than from fixed rules. High-cognition work (analysis, architecture, ambiguous trade-offs) is not handed to the cheap default `grunt`, where a weak model would produce confident nonsense — it picks a strong-model delegate or keeps the task itself. **This cuts both ways:** when the orchestrator itself runs on a mid/cheap model and a task (or a pivotal call inside it) is beyond its depth, it escalates *up* — delegating the whole task to a stronger grunt, or consulting one for a second opinion before committing (advisor-style), rather than guessing.
- **Risk / blast radius** — for production writes, destructive operations, and migrations, investigation and a dry-run plan may be delegated, but the **apply step is never blind**: the orchestrator surfaces the exact plan/commands, waits for your explicit confirmation, and only then applies. An unsupervised prod-write is never handed to the cheap `grunt` (its broad `bash`/`edit` permissions would execute it without a second opinion).

For full routing rules, escape hatches, and edge-case handling see [skills/squad-delegate/SKILL.md](skills/squad-delegate/SKILL.md).

---

## Forcing a mode

The verdict is the model's call, but you steer it directly:

- **Force SELF** — say *"do it yourself"* (or "делай сам") in your request. This is a first-class override: the orchestrator skips delegation entirely.
- **Force DELEGATE** — just say *"delegate this"* / *"делегируй"*. The orchestrator follows the instruction even when a task would otherwise look trivial.
- **Force a specific subagent** — name it: *"delegate to `Explore`"*, *"use the grunt"*. If a specialized subagent fits better than the generic `grunt`, the orchestrator prefers it on its own, but naming one is decisive.
- **Skip the drill** — frame the task as read-only / investigation, or say so outright ("just investigate, no review"). Changes always default to the full PDCA loop.

You can confirm the orchestrator is in the right mode by reading its first line — it prints `SELF: …` or `DELEGATE: …` with its reasoning before acting.

---

## What a turn looks like

The orchestrator opens with its verdict, then proceeds:

| Request | Verdict (first line) | What happens |
|---|---|---|
| "Is the working tree clean?" | `SELF: single trivial read.` | Runs `git status` itself. No subagents. |
| "Why are the prod pages timing out?" | `DELEGATE: investigation across logs/metrics → Explore, no drill.` | A read agent digs through logs/metrics; the orchestrator sanity-checks the findings and reports. |
| "Add input validation to the upload endpoint." | `DELEGATE: produces code → grunt, full PDCA.` | `grunt` implements, `drill` checks against the definition of done, up to 3 iterations, then a final sanity-check. |
| "Drop the stale `sessions_old` table on prod." | `DELEGATE: high-risk write — plan first, confirm before apply.` | Investigation and a dry-run plan may be delegated; the exact command is surfaced and **waits for your confirmation** before anything runs. |

---

## Troubleshooting

**Confirm the plugin loaded**

Check the OpenCode log for a line referencing `orchestrate.js` or `opencode-squad`. If the plugin fails to load, the log prints the error immediately after startup.

**Subagents are hidden — that is intentional**

`grunt` and `drill` do not appear in the `@` mention menu because they are registered with `hidden: true`. They are invoked internally by the orchestrator. If you need to verify they are registered, use a one-off session and ask the model to list available subagents (it can introspect the session state).

**Check which mode it chose**

The orchestrator prints its verdict (`SELF: …` / `DELEGATE: …`) as the first line of its reply. If it delegated when you wanted it to act itself, prepend "do it yourself" to your request; if it acted itself when you wanted delegation, say "delegate this". See [Forcing a mode](#forcing-a-mode).

**Iteration cap and cost**

A full PDCA iteration (the *changes* branch) fires two LLM calls (grunt + drill) on top of the orchestrator's own context. On a complex task with 3 iterations that is potentially 7+ model calls. Read-only / investigation delegations skip the drill, and trivial tasks are handled by the orchestrator directly — so cost scales with task weight, which is what the selection signals (and the live context line) are there to gauge.

---

## Development

```bash
bun install
bun test          # runs the unit suite (bootstrap, inventory, agents, context)
```

---

## License

MIT — see [LICENSE](LICENSE).
