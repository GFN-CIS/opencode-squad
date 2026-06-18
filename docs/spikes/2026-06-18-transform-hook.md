# Spike: transform-hook injection & filter mechanism

**Date:** 2026-06-18
**Environment:** opencode 1.17.7, `@opencode-ai/plugin@1.15.10` types
**Method:** throwaway plugin in `/tmp/opencode/spike-orchestrate/.opencode/plugins/spike.js`
logging real hook payloads over live `opencode run` sessions.

## Named answers (authority for Task 6)

- **`INJECT_FILTER_STRATEGY` = `"info-agent-filter"`**
  The `experimental.chat.messages.transform` hook's `input` is `{}` (no
  sessionID, no agent) — BUT each message carries `info.agent` and
  `info.sessionID`. Filter by reading `message.info.agent` directly inside the
  transform hook. No `chat.message` correlation and no inject-everywhere
  needed.

- **`SKILLS_PATHS_WORKS` = `true`**
  Pushing the bundled dir onto `config.skills.paths` inside the `config` hook
  works: the spike dir appeared alongside superpowers and time-logger paths.

- **`MESSAGES_TRANSFORM_SHAPE`**
  `output.messages` is `Array<{ info: Message; parts: Part[] }>`. Observed:
  `info.role` (`"user"`/`"assistant"`), `info.agent` (e.g. `"build"`,
  `"explore"`), `info.sessionID`. Text parts have `type === "text"` and a
  `.text` string. A first user message can have multiple text parts.

## Evidence

`config.skills.paths.after` after our push:
```
[ ".../superpowers/skills", ".../opencode-time-logger/skills",
  "/tmp/opencode/spike-orchestrate/.opencode/plugins/spike-skill" ]
```

`config.agent` programmatic define probe → logged `"ok"` (no throw). User
inventory seen: explore, implementer, code-reviewer, build, build-rules,
*-delegate agents.

`transform.messages.summary` agent values across a build session that delegated
to `@explore`:
```
   2   "agent": "build"
   9   "agent": "explore"
```
→ `info.agent` reliably reflects the session's agent. Filter
`info.agent === "build"` injects only into the orchestrator session and skips
subagent sessions (worker / work-reviewer).

`chat.message.input` carried only `{ sessionID }` (no `agent`) in 1.17.7 — so
`chat.message` is NOT a reliable agent source; `transform`'s `info.agent` is.

## CRITICAL bonus finding — plugin export form

A local plugin in `.opencode/plugins/` with `export default { server: Plugin }`
FAILED to load:
```
ERROR failed to load plugin ... error="Path plugin ... must export id"
```
Fix: `export default { id: "<unique-id>", server: Plugin }`. With the `id`
field present, the plugin loaded and all hooks fired.

**Impact on the plan:**
- Task 6: export `export default { id: "orchestrate", server: OrchestratePlugin }`.
- Task 6: in the transform hook, inject only when the target user message's
  `info.agent === "build"` (use the orchestrator/primary agent name); skip
  otherwise. This supersedes the plan's `inject-everywhere` assumption.
- Global Constraints note "`export default { server: ... }`" must be amended to
  include the `id` field.
