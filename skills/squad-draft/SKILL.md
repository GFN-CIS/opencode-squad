---
name: squad-draft
description: Use when the user wants to draft, set up, or refresh the per-model squad — a grunt (worker) AND a drill (reviewer) per model — from one model list, so the sarge orchestrator can pick an executor or a reviewer by model capability. When invoked, DRIVE it — discover the available models, propose a curated roster, ask what to add or remove, then generate. Triggers: "draft squad", "set up grunts/drills", "model squad", "набери сквад", "сделай агентов по моделям".
license: MIT
---

# squad-draft — scaffold the per-model squad (grunts + drills)

opencode's `task` tool takes only `subagent_type` (no model), so the only way to
let sarge choose a model — for execution OR review — is a named agent per model.
This skill scaffolds both roles from one list: a `grunt-<provider>-<model>`
(executor) and a `drill-<provider>-<model>` (read-only reviewer) for each model.

**Be proactive.** The moment this skill is invoked, run the whole flow yourself —
discover, propose, ask, generate. Do NOT sit waiting for the user to hand you a
model list; proposing the list is your job. (The user may override or hand you an
explicit list — honor it.)

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
   "why". The same list is used for both grunts and drills.

3. **Ask** — in one message (use the question tool if available): "Here's the
   proposed squad roster (a grunt + a drill per model). Add or remove anything,
   or say go." Wait for the answer and fold in their edits. Do not generate
   before they confirm.

4. **Generate** the confirmed roster. Locate the bundled generator and run it:
   ```bash
   SCRIPT="$(find ~/.cache/opencode/packages -path '*node_modules/opencode-squad/scripts/squad-draft.mjs' 2>/dev/null | head -1)"
   [ -z "$SCRIPT" ] && SCRIPT="$(find ~ -path '*opencode-squad/scripts/squad-draft.mjs' 2>/dev/null | head -1)"
   node "$SCRIPT" <confirmed provider/model ids...>
   ```
   For each model it writes a hidden `grunt-<slug>.md` (executor) and a
   `drill-<slug>.md` (read-only reviewer) to the global agent dir
   (`~/.config/opencode/agent/`). Flags: `--dir <path>` to target a project's
   `.opencode/agent`; `--no-prune` to keep agents not in the list. Re-running
   syncs the set and prunes generated grunts/drills (incl. legacy `worker-*`) no
   longer listed — hand-authored agents are never touched.

5. **Report** the written/pruned files and tell the user to reload opencode
   (restart the TUI / start a new run) so the new agents load. The generic
   `grunt` / `drill` remain as the default.

## Notes

- Naming: `provider/model` → `grunt-<provider>-<model>` and
  `drill-<provider>-<model>` (non-alphanumerics collapsed to `-`, e.g.
  `openai/gpt-5.5` → `grunt-openai-gpt-5-5` / `drill-openai-gpt-5-5`).
- grunts get `edit`/`bash`; drills are read-only (`edit`/`bash` denied, `webfetch`
  allowed) — same contract as the bundled `grunt` / `drill`.
- To change behavior, edit the bundled `prompts/grunt.md` / `prompts/drill.md`
  and regenerate — the prompt body is inlined per file.
