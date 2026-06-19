# opencode-orchestrate

An OpenCode plugin that turns the built-in `build` agent into a PDCA orchestrator. On every request it states an explicit `SELF`/`DELEGATE` verdict: trivial work it does itself; real work it hands to a `worker` subagent — routing changes through a `work-reviewer` (the Deming check), and investigations straight back to itself. A live context-usage signal feeds the decision so a heavy task isn't burned into an already-full context.

---

## Install

Add one line to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-orchestrate@git+https://github.com/AlexMKX/opencode-orchestrate.git"]
}
```

That is all. On next start, OpenCode registers everything automatically.

---

## What you get

| Component | Type | Notes |
|---|---|---|
| `worker` | hidden subagent | Executes delegated tasks |
| `work-reviewer` | hidden subagent | Reviews worker output, returns a strict JSON verdict |
| `orchestrating-subagents` | skill | Loaded into the `build` agent; governs the PDCA cycle |
| Bootstrap | hidden injection | Injected into the first user message of the `build` agent; sets the orchestrator role and selection rules, the current local time, the orchestrator's own model, and an inventory of subagents (each with its model) |
| Context signal | hidden injection | A live `<ORCHESTRATE_CONTEXT>` line added to the latest user message each turn, reporting current context usage so the orchestrator can weigh it in the decision |

The bootstrap carries live session facts resolved at injection time — the current local time (with timezone) and the model the orchestrator is actually running on (so an Opus session does not mistake itself for Sonnet). Each subagent in the inventory is listed with its model, so the orchestrator can match work to capability.

"Hidden" means the subagents are registered but do not appear in the `@` mention menu. The orchestrator invokes them programmatically via the task tool. Both injections target **only the `build` agent's own sessions** — worker/reviewer subagent sessions are never injected into, so there is no recursion.

---

## Optional: override subagent models

The default model for both subagents is `anthropic/claude-sonnet-4-6`. To use a different model for either subagent, add an `agent` block to your `opencode.json`:

```json
{
  "plugin": ["opencode-orchestrate@git+https://github.com/AlexMKX/opencode-orchestrate.git"],
  "agent": {
    "worker": { "model": "anthropic/claude-sonnet-4-6" },
    "work-reviewer": { "model": "anthropic/claude-haiku-4-5" }
  }
}
```

Your `agent` block wins; anything you do not specify falls back to the default.

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

- **Read-only / investigation** (status checks, "why is X", log/metric digs) → delegate execution to `worker` (or a specialized read agent like `Explore`) with **no reviewer** — there is no artifact to review. The orchestrator sanity-checks the findings itself, then reports.
- **Changes** (code / docs / config) → the full PDCA loop:
  1. **Plan / Do** — calls `worker` with the brief, definition of done, context, and (from iteration 2 onward) the reviewer's feedback.
  2. **Check** — calls `work-reviewer` with the brief and the worker's output. The reviewer returns a strict JSON verdict: `{"verdict": "PASS"|"FAIL", "checks": [...], "issues": [...], "suggested_fixes": [...], "blocking": <bool>}`.
  3. **Act** — on `PASS`, the orchestrator runs a final sanity-check (e.g. tests/lint) and delivers the result. On `FAIL`, it retries — up to **3 iterations total**, then escalates to the user rather than retrying blindly.

### Matching the delegate (capability & risk)

Delegating only helps if the delegate is actually fit for the task. The injected inventory lists each subagent's model, and the orchestrator weighs two things before handing work over:

- **Capability** — the orchestrator routes by what the *specific* models involved are good and bad at as of the current date (its own model and each subagent's model are in the bootstrap/inventory), rather than from fixed rules. High-cognition work (analysis, architecture, ambiguous trade-offs) is not handed to the cheap default `worker`, where a weak model would produce confident nonsense — it picks a strong-model delegate or keeps the task itself.
- **Risk / blast radius** — for production writes, destructive operations, and migrations, investigation and a dry-run plan may be delegated, but the **apply step is never blind**: the orchestrator surfaces the exact plan/commands, waits for your explicit confirmation, and only then applies. An unsupervised prod-write is never handed to the cheap `worker` (its broad `bash`/`edit` permissions would execute it without a second opinion).

For full routing rules, escape hatches, and edge-case handling see [skills/orchestrating-subagents/SKILL.md](skills/orchestrating-subagents/SKILL.md).

---

## Forcing a mode

The verdict is the model's call, but you steer it directly:

- **Force SELF** — say *"do it yourself"* (or "делай сам") in your request. This is a first-class override: the orchestrator skips delegation entirely.
- **Force DELEGATE** — just say *"delegate this"* / *"делегируй"*. The orchestrator follows the instruction even when a task would otherwise look trivial.
- **Force a specific subagent** — name it: *"delegate to `Explore`"*, *"use the worker"*. If a specialized subagent fits better than the generic `worker`, the orchestrator prefers it on its own, but naming one is decisive.
- **Skip the reviewer** — frame the task as read-only / investigation, or say so outright ("just investigate, no review"). Changes always default to the full PDCA loop.

You can confirm the orchestrator is in the right mode by reading its first line — it prints `SELF: …` or `DELEGATE: …` with its reasoning before acting.

---

## What a turn looks like

The orchestrator opens with its verdict, then proceeds:

| Request | Verdict (first line) | What happens |
|---|---|---|
| "Is the working tree clean?" | `SELF: single trivial read.` | Runs `git status` itself. No subagents. |
| "Why are the prod pages timing out?" | `DELEGATE: investigation across logs/metrics → Explore, no reviewer.` | A read agent digs through logs/metrics; the orchestrator sanity-checks the findings and reports. |
| "Add input validation to the upload endpoint." | `DELEGATE: produces code → worker, full PDCA.` | `worker` implements, `work-reviewer` checks against the definition of done, up to 3 iterations, then a final sanity-check. |
| "Drop the stale `sessions_old` table on prod." | `DELEGATE: high-risk write — plan first, confirm before apply.` | Investigation and a dry-run plan may be delegated; the exact command is surfaced and **waits for your confirmation** before anything runs. |

---

## Troubleshooting

**Confirm the plugin loaded**

Check the OpenCode log for a line referencing `orchestrate.js` or `opencode-orchestrate`. If the plugin fails to load, the log prints the error immediately after startup.

**Subagents are hidden — that is intentional**

`worker` and `work-reviewer` do not appear in the `@` mention menu because they are registered with `hidden: true`. They are invoked internally by the orchestrator. If you need to verify they are registered, use a one-off session and ask the model to list available subagents (it can introspect the session state).

**Check which mode it chose**

The orchestrator prints its verdict (`SELF: …` / `DELEGATE: …`) as the first line of its reply. If it delegated when you wanted it to act itself, prepend "do it yourself" to your request; if it acted itself when you wanted delegation, say "delegate this". See [Forcing a mode](#forcing-a-mode).

**Iteration cap and cost**

A full PDCA iteration (the *changes* branch) fires two LLM calls (worker + reviewer) on top of the orchestrator's own context. On a complex task with 3 iterations that is potentially 7+ model calls. Read-only / investigation delegations skip the reviewer, and trivial tasks are handled by the orchestrator directly — so cost scales with task weight, which is what the selection signals (and the live context line) are there to gauge.

---

## Development

```bash
bun install
bun test          # runs the unit suite (bootstrap, inventory, agents, context)
```

---

## License

MIT — see [LICENSE](LICENSE).
