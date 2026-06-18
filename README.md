# opencode-orchestrate

An OpenCode plugin that turns the built-in `build` agent into a PDCA orchestrator, delegating non-trivial work to a `worker` subagent and routing its output through a `work-reviewer` subagent before accepting the result.

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
| Bootstrap | hidden injection | Injected once into the first user message of the `build` agent; contains an inventory of available subagents |

"Hidden" means the subagents are registered but do not appear in the `@` mention menu. The orchestrator invokes them programmatically via the task tool.

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

## How the PDCA cycle works

The `build` agent (the orchestrator) decides at the start of each task whether to act itself or delegate:

- **Trivial task** (single step, no ambiguity) — orchestrator does it directly. No subagents are involved.
- **Non-trivial task** — the orchestrator formulates a task brief and definition of done, then runs the loop:
  1. **Plan / Do** — calls `worker` with the brief, context, and (from iteration 2 onward) the reviewer's feedback.
  2. **Check** — calls `work-reviewer` with the brief and the worker's output. The reviewer returns a strict JSON verdict: `{"verdict": "PASS"|"FAIL", "checks": [...], "issues": [...], "suggested_fixes": [...], "blocking": <bool>}`.
  3. **Act** — on `PASS`, the orchestrator runs a final sanity-check (e.g. tests/lint) and delivers the result. On `FAIL`, it retries — up to **3 iterations total**.

After 3 failures the orchestrator escalates to the user rather than retrying blindly.

For full routing rules, escape hatches, and edge-case handling see [skills/orchestrating-subagents/SKILL.md](skills/orchestrating-subagents/SKILL.md).

---

## Troubleshooting

**Confirm the plugin loaded**

Check the OpenCode log for a line referencing `orchestrate.js` or `opencode-orchestrate`. If the plugin fails to load, the log prints the error immediately after startup.

**Subagents are hidden — that is intentional**

`worker` and `work-reviewer` do not appear in the `@` mention menu because they are registered with `hidden: true`. They are invoked internally by the orchestrator. If you need to verify they are registered, use a one-off session and ask the model to list available subagents (it can introspect the session state).

**Iteration cap and cost**

Each PDCA iteration fires two LLM calls (worker + reviewer) on top of the orchestrator's own context. On a complex task with 3 iterations that is potentially 7+ model calls. Use this plugin for genuinely non-trivial work; the orchestrator is instructed to handle simple tasks itself.

---

## Development

```bash
bun install
bun test          # runs 9 unit tests
```

---

## License

MIT — see [LICENSE](LICENSE).
