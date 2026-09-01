---
name: squad-draft
description: Use when the user wants to draft, set up, refresh or retune the per-model squad — the grunt (executor) and drill (reviewer) agents the sarge orchestrator dispatches by model. Covers adding or removing a model, changing a model's reasoning level, and writing the descriptions sarge routes on. When invoked, DRIVE it — read the current roster, propose a delta, ask, apply. Triggers — "draft squad", "set up grunts/drills", "model squad", "add <model> to the squad", "набери сквад", "сделай агентов по моделям", "добавь модель в сквад", "поставь variant".
license: MIT
---

# squad-draft — the per-model squad (grunts + drills)

opencode's `task` tool takes only `subagent_type` (no model), so the only way to
let sarge choose a model — for execution OR review — is a named agent per model:
a `grunt-<provider>-<model>` (executor) and a `drill-<provider>-<model>`
(read-only reviewer).

The squad is edited through two tools, `squad_dump` and `squad_patch`. The
roster they speak is one map per role, keyed by model id:

```json
{ "grunts": { "zai-coding-plan/glm-5.3": { "variant": "high",
                                           "description": "cheap 1M ctx coder" },
              "openai/gpt-5.6-luna": { "description": "fast mechanical edits" } },
  "drills": { "anthropic/claude-opus-5": { "variant": "max",
                                           "description": "final reviewer" } } }
```

An agent exists if it appears in a role map, and `{}` is a valid entry meaning
"this model, role defaults". Per-agent fields: `variant`, `description`,
`notes`, `steps`, `disable` — all optional, all described in the tool schema.

**Be proactive.** The moment this skill is invoked, run the whole flow yourself.
Do NOT sit waiting for the user to hand you a model list; proposing it is your
job. (If they hand you an explicit list, honor it.)

## Flow

0. **Read the squad that already exists — before proposing anything.** Call
   `squad_dump`. If the squad is non-empty, the task is almost always a DELTA —
   "add glm-5.3", "make the GLM grunt think harder", "drop the qwen one". Keep
   every agent you were not asked about. Composing a fresh roster from memory is
   how a squad of seven became a squad of one; `squad_patch` will refuse it, but
   the refusal is a backstop, not the plan.

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

   **A drill is not a free extra — decide it per model.** A grunt executes; a
   drill REVIEWS a grunt's work and its verdict is what sarge acts on. A weak
   model in that seat either rubber-stamps whatever it is shown or invents faults
   that aren't there, and both are worse than shipping with no review at all,
   because they launder a bad change as an approved one. So put a model in
   `drills` only if it can genuinely review — the strong and balanced tiers.
   Cheap, fast and small models go in `grunts` alone: they work, they do not
   judge. Say which models you are proposing grunt-only, and why.

3. **Write a real `description` for every agent.** This is the one field sarge
   actually reads at the moment of choice: it goes verbatim into the subagent
   inventory line the orchestrator scans when picking `subagent_type`. Left out,
   it falls back to a generic role sentence — and a squad where all ten grunts
   say "Per-model grunt (worker) for the sarge PDCA cycle" gives sarge nothing to
   choose on but the model name. Write when to pick this one: "cheap, 1M context,
   mechanical edits", "strong analysis, slow and expensive", "code-specialized,
   weak at ambiguous specs". One line, concrete, comparative.

4. **Pick a reasoning `variant` for each agent whose model publishes one.**
   Without a variant, opencode sends NO reasoning parameter — and for an
   openai-compatible provider that means the model's reasoning is bounded by
   nothing but the output cap. Measured on `zai-coding-plan/glm-5.3`: 70% of the
   token budget went to reasoning (against ~20% for Claude), with a tail to ~19k
   reasoning tokens in one turn, and two grunts were truncated mid-thought having
   emitted 2 and 9 tokens of actual answer. Anthropic models stay bounded on
   their server-side adaptive default; openai-compatible ones have no such
   fallback.

   So a variant is **not** a way to suppress reasoning — it puts an unbounded
   reasoner under the same kind of governor Claude already has. The variant is
   per AGENT, so a drill may legitimately think harder than the grunt on the same
   model: reviewing is the harder call. Prefer `high` for grunts, `high` or `max`
   for drills; `low` only when the user asks for cheap and fast.

   **Do not work out which levels are valid — `squad_dump` already told you.**
   Its output ends with the list opencode itself accepts per model, which is
   authoritative. Do NOT derive them from models.dev `reasoning_options`: those
   come in three types that opencode turns into different names, and reading
   only the `effort` values under-reports. `claude-haiku-4-5` publishes just
   `[{type: "budget_tokens", min: 1024}]`, so an effort reading says "no
   variants" while opencode in fact accepts `high` and `max`.

   A model listed with `(none — leave variant unset)` genuinely has no usable
   knob; leave it alone. `squad_patch` rejects a variant opencode would not
   accept, rather than writing one it would silently drop — so if you get that
   error, read the accepted list in it, do not retry with another guess.

5. **Ask, as a delta.** In one message (use the question tool if available), show
   what will CHANGE against the dumped roster, not just the end state:
   ```
   + grunt zai-coding-plan/glm-5.3   variant high, "cheap 1M ctx coder"
   ~ drill anthropic/claude-opus-5   variant max (was none)
   - nothing
   = 6 agents unchanged
   ```
   Anything you propose to DELETE must be named explicitly and justified — never
   let a deletion ride along inside a rewrite. Wait for the answer and fold in
   their edits. Do not apply before they confirm.

6. **Apply with `squad_patch`**, passing the COMPLETE intended squad — the
   document you got from `squad_dump` with your edits folded in.

   - **Deletions are refused by default.** Any agent present now and absent from
     your roster is a deletion, including dropping a drill from a model that
     keeps its grunt. The patch writes nothing at all and names what it would
     have deleted. Hitting that means your roster is wrong, not that the tool is
     in your way: re-dump and edit that one. Pass `allow_remove: true` ONLY when
     the user asked for it.
   - Prefer `disable: true` over deleting an agent the user may want back — it
     stops being dispatchable but keeps its settings.
   - `directory` targets a project's `.opencode/agent` instead of the global
     `~/.config/opencode/agent`.
   - Hand-authored agents are invisible to both tools: never dumped, never
     pruned.

7. **Report** the applied diff (`+added / -removed / ~changed / =unchanged`),
   echo the variants that were written — opencode ignores an unrecognized one
   without erroring, so this is the only place a typo shows up — and tell the
   user to reload opencode (restart the TUI / start a new run) so the new agents
   load. The generic `grunt` / `drill` remain as the default.

## Notes

- Naming: `provider/model` → `grunt-<provider>-<model>` /
  `drill-<provider>-<model>`, non-alphanumerics collapsed to `-` (e.g.
  `openai/gpt-5.5` → `grunt-openai-gpt-5-5`). One agent per model per role, so
  changing a level does not rename anything and sarge keeps dispatching by the
  same `subagent_type`.
- grunts get `edit`/`bash`; drills are read-only (`edit`/`bash` denied,
  `webfetch` allowed). That contract is NOT roster-settable — a writable
  reviewer is a safety problem, not a preference.
- `notes` are appended to that one agent's prompt, fenced by markers so they
  round-trip through `squad_dump`. Use them for per-model quirks, not for policy
  that belongs in the shared role prompt.
- To change behavior for ALL agents of a role, edit the bundled
  `prompts/grunt.md` / `prompts/drill.md` and re-apply — the prompt body is
  inlined per file.
