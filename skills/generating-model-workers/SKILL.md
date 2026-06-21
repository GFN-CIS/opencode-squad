---
name: generating-model-workers
description: Use when the user wants to create per-model worker subagents (worker-<provider>-<model>) from a list of model ids, so the orchestrator can pick a worker by model capability. The user supplies the model list; this skill generates the agents.
license: MIT
---

# Generating Per-Model Workers

opencode's `task` tool takes only `subagent_type` (no model), so the only way to
let the orchestrator choose a model is to have one named worker agent per model.
This skill materializes those agents from a user-supplied list of `provider/model`
ids. Each generated worker is hidden, `mode: subagent`, shares the bundled worker
prompt and permissions, and differs only in its `model`. They appear in the
orchestrator's inventory (with their models), which is what makes the
capability-matching rule actionable.

This is operator-driven: the user gives the list; you generate. Do not invent or
auto-discover models unless asked.

## Steps

1. **Get the model list.** The user provides `provider/model` ids, e.g.:
   ```
   anthropic/claude-opus-4-7
   openai/gpt-5.5
   google/gemini-3.5-flash
   ```
   If any id does not look like `provider/model`, confirm with the user before
   generating. Optionally cross-check against the live provider list
   (`/config/providers`) and warn about ids that don't resolve — but never drop
   one silently; report and ask.

2. **Locate the generator** (shipped with this package):
   ```bash
   SCRIPT="$(find ~/.cache/opencode/packages -path '*node_modules/opencode-orchestrate/scripts/generate-workers.mjs' 2>/dev/null | head -1)"
   [ -z "$SCRIPT" ] && SCRIPT="$(find ~ -path '*opencode-orchestrate/scripts/generate-workers.mjs' 2>/dev/null | head -1)"
   echo "$SCRIPT"
   ```

3. **Run it** with the model ids (writes to the global agent dir
   `~/.config/opencode/agent/` by default; re-running syncs the managed set and
   prunes generated workers no longer in the list — hand-authored agents are
   never touched):
   ```bash
   node "$SCRIPT" anthropic/claude-opus-4-7 openai/gpt-5.5 google/gemini-3.5-flash
   ```
   Flags: `--dir <path>` to target a different agent dir (e.g. a project's
   `.opencode/agent`), `--no-prune` to keep previously generated workers.

4. **Report** which `worker-*.md` files were written/pruned, and tell the user to
   **reload opencode** (restart the TUI or start a new run) so the new agents
   load. The generic `worker` / `work-reviewer` remain as the default/fallback.

## Notes

- Naming: `provider/model` → `worker-<provider>-<model>` with non-alphanumerics
  collapsed to `-` (e.g. `openai/gpt-5.5` → `worker-openai-gpt-5-5`).
- To change every generated worker's behavior, edit the bundled
  `prompts/worker.md` and regenerate — the prompt body is inlined per file.
