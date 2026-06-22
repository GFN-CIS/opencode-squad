---
name: draft-grunts
description: Use when the user wants to draft, set up, or refresh the per-model grunt roster (grunt-<provider>-<model>) so the sarge orchestrator can pick a grunt by model capability. When invoked, DRIVE it — discover the available models, propose a curated roster, ask what to add or remove, then generate. Triggers: "draft grunts", "set up grunts", "model grunts/workers", "набери грантов", "сделай агентов по моделям".
license: MIT
---

# draft-grunts — draft the per-model grunt roster

opencode's `task` tool takes only `subagent_type` (no model), so the only way to
let sarge choose a model is a named grunt agent per model. This skill drafts that
roster.

**Be proactive.** The moment this skill is invoked, run the whole flow yourself —
discover, propose, ask, generate. Do NOT sit waiting for the user to hand you a
model list; proposing the list is your job. (The user may of course override or
hand you an explicit list — honor it.)

## Flow

1. **Discover** the models actually available in this install:
   ```bash
   opencode models
   ```
   (Filter if useful, e.g. `opencode models anthropic`.) Skip the noise —
   free/preview/image/tts/embedding/`-lite` models — unless the user wants them.

2. **Propose a roster.** From what's available, pick a curated, *tiered* set that
   gives sarge real choice without bloat — roughly one or two per tier, spread
   across providers:
   - **strong** — analysis, architecture, hard reasoning;
   - **balanced** — default implementation workhorse;
   - **cheap & fast** — mechanical, high-volume work;
   - **code-specialized** — if such a model is available.
   Present it as a concrete list of `provider/model` ids, each with a one-line
   "why", e.g.:
   ```
   anthropic/claude-opus-4-8    — strong: architecture, hard analysis
   anthropic/claude-sonnet-4-6  — balanced workhorse
   anthropic/claude-haiku-4-5   — cheap/fast, mechanical
   openai/gpt-5.5               — strong, alternative perspective
   openai/gpt-5.3-codex         — code-specialized
   google/gemini-3.5-flash      — cheapest, large context
   ```

3. **Ask** — in one message (use the question tool if available): "Here's the
   proposed grunt roster. Add or remove anything, or say go." Wait for the
   answer and fold in their edits. Do not generate before they confirm.

4. **Generate** the confirmed roster. Locate the bundled generator and run it:
   ```bash
   SCRIPT="$(find ~/.cache/opencode/packages -path '*node_modules/opencode-squad/scripts/generate-workers.mjs' 2>/dev/null | head -1)"
   [ -z "$SCRIPT" ] && SCRIPT="$(find ~ -path '*opencode-squad/scripts/generate-workers.mjs' 2>/dev/null | head -1)"
   node "$SCRIPT" <confirmed provider/model ids...>
   ```
   It writes hidden `grunt-<provider>-<model>` agents to the global agent dir
   (`~/.config/opencode/agent/`). Flags: `--dir <path>` to target a project's
   `.opencode/agent`; `--no-prune` to keep grunts not in the list. Re-running
   syncs the set and prunes generated grunts (incl. legacy `worker-*`) no longer
   listed — hand-authored agents are never touched.

5. **Report** the written/pruned `grunt-*.md` files and tell the user to reload
   opencode (restart the TUI / start a new run) so the new agents load. The
   generic `grunt` / `drill` remain as the default.

## Notes

- Naming: `provider/model` → `grunt-<provider>-<model>` with non-alphanumerics
  collapsed to `-` (e.g. `openai/gpt-5.5` → `grunt-openai-gpt-5-5`).
- To change every generated grunt's behavior, edit the bundled `prompts/grunt.md`
  and regenerate — the prompt body is inlined per file.
