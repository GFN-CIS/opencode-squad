---
name: squad-draft
description: Use when the user wants to draft, set up, or refresh the per-model squad — a grunt (worker) AND a drill (reviewer) per model — from one model list, so the sarge orchestrator can pick an executor or a reviewer by model capability. When invoked, DRIVE it — discover the available models, propose a curated roster, ask what to add or remove, then generate. Triggers — "draft squad", "set up grunts/drills", "model squad", "набери сквад", "сделай агентов по моделям".
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

0. **Read the squad that already exists — before proposing anything.** Call the
   `squad_dump` tool. It returns the current roster as JSON, derived from the
   generated agent files:
   ```json
   { "version": 1,
     "models": [ { "id": "anthropic/claude-opus-5" },
                 { "id": "zai-coding-plan/glm-5.3", "variant": "high" },
                 { "id": "openai/gpt-5.6-luna", "roles": ["grunt"] } ] }
   ```
   `roles` appears only when it is not the default pair, so an entry without it
   has both a grunt and a drill.
   If the squad is non-empty, the task is almost always a DELTA — "add glm-5.3",
   "make the GLM grunt think less", "drop the qwen one". Keep every entry you
   were not asked about. Composing a fresh roster from memory is how a squad of
   seven became a squad of one; `squad_patch` will refuse it, but the refusal is
   a backstop, not the plan.

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
   "why".

   **A drill is not a free extra — decide it per model.** A grunt executes; a
   drill REVIEWS a grunt's work and its verdict is what sarge acts on. A weak
   model in that seat either rubber-stamps whatever it is shown or invents
   faults that aren't there, and both are worse than shipping with no review at
   all, because they launder a bad change as an approved one. So give a drill
   only to models that can genuinely review — the strong and balanced tiers.
   Cheap/fast and small models get `roles: ["grunt"]`: they work, they do not
   judge. Say which models you are proposing grunt-only, and why.

2a. **Pick a reasoning variant for each model that publishes one.** Without a
   variant, opencode sends NO reasoning parameter — and for an
   openai-compatible provider that means the model's reasoning is bounded by
   nothing but the output cap. Measured on `zai-coding-plan/glm-5.3`: 70% of the
   token budget went to reasoning (against ~20% for Claude), with a tail to ~19k
   reasoning tokens in a single turn, and two grunts were truncated mid-thought
   having emitted 2 and 9 tokens of actual answer. Anthropic models stay bounded
   on their server-side adaptive default; openai-compatible ones have no such
   fallback.

   So a variant is **not** a way to suppress reasoning — it puts an unbounded
   reasoner under the same kind of governor Claude already has. Prefer `high`
   for grunts and drills; reach for `low` only when the user asks for cheap and
   fast, and for `max` only on genuinely hard analysis.

   Valid values are per-model, from that model's `reasoning_options` in
   models.dev — e.g. `glm-5.3` publishes `low|high|max` (no `medium`),
   `claude-opus-5` `low|medium|high|xhigh|max`, `gpt-5.6-terra` adds `none`:
   ```bash
   curl -s https://models.dev/api.json \
     | python3 -c 'import json,sys; d=json.load(sys.stdin); p,m="PROVIDER","MODEL"; print(d[p]["models"][m].get("reasoning_options"))'
   ```
   **An unrecognized variant is silently ignored** by opencode — a typo buys you
   silence, not an error. Never guess a level; if you cannot read the model's
   options, leave the variant off and say so. Models that publish no
   `reasoning_options` get no variant.

3. **Ask, as a delta.** In one message (use the question tool if available),
   show what will CHANGE against the exported roster, not just the end state:
   ```
   + zai-coding-plan/glm-5.3@high   (new: code grunt, bounded reasoning)
   ~ openai/gpt-5.6-terra           medium -> high
   = 5 models unchanged
   ```
   Then: "Add or remove anything, or say go." Anything you propose to REMOVE
   must be named explicitly and justified — never let a removal ride along
   inside a rewrite. Wait for the answer and fold in their edits. Do not
   generate before they confirm.

4. **Apply the edited roster** with `squad_patch`, passing the COMPLETE
   intended squad — the list you got from `squad_dump` with your edits folded
   in. It writes a hidden `grunt-<slug>.md` (executor) and `drill-<slug>.md`
   (read-only reviewer) per model, and returns the diff it applied.

   - **Deletions are refused by default.** That covers both a model leaving the
     roster and a `roles` narrowed on a model that stays — either way an agent
     file disappears. The patch writes nothing at all and names what it would
     have deleted. Hitting that means your roster is wrong, not that the tool is
     in your way: re-dump and edit that one. Pass `allow_remove: true` ONLY when
     the user asked for it. Note the asymmetry: OMITTING `roles` means both and
     deletes nothing, so you can only lose a drill by actually typing the field.
   - `directory` targets a project's `.opencode/agent` instead of the global
     `~/.config/opencode/agent`.
   - Hand-authored agents are invisible to both tools: never dumped, never
     pruned.

5. **Report** the applied diff (`+added / -removed / ~changed / =unchanged`),
   echo the variants that were written — opencode ignores an unrecognized one
   without erroring, so this is the only place a typo shows up — and tell the
   user to reload opencode (restart the TUI / start a new run) so the new agents
   load. The generic `grunt` / `drill` remain as the default.

## Notes

- Naming: `provider/model` → `grunt-<provider>-<model>` and
  `drill-<provider>-<model>` (non-alphanumerics collapsed to `-`, e.g.
  `openai/gpt-5.5` → `grunt-openai-gpt-5-5` / `drill-openai-gpt-5-5`).
- grunts get `edit`/`bash`; drills are read-only (`edit`/`bash` denied, `webfetch`
  allowed) — same contract as the bundled `grunt` / `drill`.
- To change behavior, edit the bundled `prompts/grunt.md` / `prompts/drill.md`
  and regenerate — the prompt body is inlined per file.
- The variant does NOT change the agent name: one agent per model, not per
  level. Changing a model's level means regenerating that model's two files, and
  `sarge` keeps dispatching it by the same `subagent_type`.
