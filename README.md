# opencode-squad

An OpenCode plugin that turns the built-in `build` agent into a PDCA orchestrator. On every request it states an explicit `SELF`/`DELEGATE` verdict: trivial work it does itself; real work it hands to a per-model `grunt-*` subagent — routing changes through the matching `drill-*` (the Deming check), and investigations straight back to itself. A live context-usage signal feeds the decision so a heavy task isn't burned into an already-full context.

---

## Install

Add one line to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-squad@git+https://github.com/GFN-CIS/opencode-squad.git"]
}
```

That is all. On next start, OpenCode registers the skills and bootstrap automatically. There is no bundled grunt/drill agent — run the `squad-draft` skill once to generate the per-model squad the orchestrator delegates to.

---

## What you get

| Component | Type | Notes |
|---|---|---|
| `squad-delegate` | skill | The orchestrator's delegation protocol — loaded on demand when it decides to delegate (shapes, PDCA, risk gate) |
| `squad-stall` | skill | The orchestrator's stall-breaking ladder — loaded on demand when it recognizes it's stuck (kept separate so a stall doesn't pull in the whole delegation protocol) |
| `squad-draft` | skill | Scaffolds the per-model squad — discovers available models, proposes a tiered set, asks what to add/remove, then generates a hidden `grunt-<provider>-<model>` (executor) **and** `drill-<provider>-<model>` (reviewer) for each, giving the orchestrator a menu of models for both roles |
| `squad-redteam` | skill | Cross-model red-team / second-opinion review — dispatches the same artifact or question to several `grunt-*` agents in parallel (user picks the panel via a multi-select question, defaulting to the single strongest grunt per provider) and has the orchestrator cross-analyze their independent findings into one consolidated report. Uses grunts, not drills, since the panel needs live MCP/gitlab/webfetch access to fetch the artifact itself. Same parallel-dispatch-and-consolidate idea as [`@alexmkx/opencode-multi-delegate`](https://github.com/AlexMKX/opencode-multi-delegate), reusing the squad's own grunts instead of a separate delegate config |
| Bootstrap | hidden injection | Injected into the first user message of the `build` agent; sets the orchestrator role and selection rules, the current local time, the orchestrator's own model, and an inventory of subagents (each with its model) |
| Context signal | hidden injection | A live `<ORCHESTRATE_CONTEXT>` line added to the latest user message each turn, reporting current context usage so the orchestrator can weigh it in the decision |

The bootstrap carries live session facts resolved at injection time — the current local time (with timezone) and the model the orchestrator is actually running on (so an Opus session does not mistake itself for Sonnet). Each subagent in the inventory is listed with its model, its **context window** (`ctx`, from opencode), and a minimal **Artificial Analysis capability summary** (`intel · code · agentic · $/M`) — the aggregated facts sarge needs to route by real numbers, not vibes:

```
grunt-openai-gpt-5-5 … (model: openai/gpt-5.5 · ctx 400k — AA intel 55 · code 75 · agentic 89 · $11.25/M)
```

The AA data is a static snapshot (`src/benchmarks.json`, refreshable via `scripts/refresh-benchmarks.mjs`); no raw sub-benchmarks or speed metrics are shown.

If a `model_data.json` exists (in the project's `.opencode/` or the global `~/.config/opencode/`), the inventory reads its perf from **there** instead of the raw AA dump. It's a small, hand-editable snapshot holding **only the models that have a grunt-/drill- agent**, keyed by the opencode `provider/model` id, with the AA indices copied in plus an `info` note you fill yourself ("good for coding, weak at long context") — which then shows up inline in the inventory so the orchestrator routes on your guidance, not just the numbers. Without the file, the inventory falls back to `benchmarks.json` exactly as before.

Add `"billing": "subscription"` to an entry to mark a model as covered by a flat-rate subscription (Claude Pro/Max, GitHub Copilot, ChatGPT Plus, …) rather than metered API billing. The inventory then shows `billing: subscription (flat-rate, ~$0 marginal)` instead of the AA `$/M` list price, so the orchestrator doesn't mistake a subscription-covered grunt for an expensive one — see [Weighing real cost](#weighing-real-cost-caching-subscriptions-context) below. Like `info`, it's a hand-added field the perf refresh never touches.

The **global** `~/.config/opencode/model_data.json` is refreshed automatically on opencode startup: the plugin rescans your squad, refreshes the perf from `benchmarks.json`, **merges** (your `info` and any hand-added field are preserved), and writes **only when the models actually changed** — so a new grunt/drill or a fresh benchmark snapshot lands on its own without churning the file or clobbering edits. Note that hand-edited *perf numbers* are overwritten by this refresh (they're derived); only non-perf fields survive. To (re)generate it explicitly — or to target a project's `.opencode/` — run `node scripts/squad-file-performance.mjs [--dir <agentDir>] [--out <file>]`; project-level files are never auto-touched.

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

## Per-model squad (grunts + drills)

opencode's `task` tool takes only `subagent_type` (no model), so the only way to let the orchestrator *choose* a model — for execution or for review — is a named agent per model per role. The `squad-draft` skill sets this up interactively: invoke it and it discovers the available models (`opencode models`), proposes a tiered roster, asks what to add or remove, then — on your OK — writes a hidden **grunt** (executor) and **drill** (read-only reviewer) per model into `~/.config/opencode/agent/`.

```
openai/gpt-5.5  →  grunt-openai-gpt-5-5   (executor: edit/bash)
                →  drill-openai-gpt-5-5   (reviewer: read-only)
```

Each generated agent shares the bundled grunt/drill prompt and permissions, differs only in `model`, and is `hidden` (dispatched via `task`, not in the `@`-menu). They appear in the orchestrator's inventory **with their models and capability summary**, which makes the routing concrete — analysis/architecture to a strong model, mechanical work to a cheap one, and reviews on a model strong enough to actually catch problems. Re-running syncs the set (prunes generated grunts/drills no longer listed; never touches hand-authored agents). Reload opencode to pick up new agents.

There is no bundled fallback agent — if no `grunt-*`/`drill-*` exists yet, the orchestrator tells you to run `squad-draft` instead of inventing a subagent or quietly doing the work itself.

---

## Rate-limit guard

opencode's own retry policy retries a rate-limited/overloaded provider call **forever** — it honors the provider's `retry-after` header up to ~24.8 days, or backs off (capped at 30s) when there's no header. There is no config for this in opencode core. For a subagent dispatched via `task`, that leaves the orchestrator blocked with no idea it could just pick a different model.

This plugin watches subagent sessions for retry activity and steps in once either of two thresholds is crossed:

Config is passed as **plugin-tuple options**, not a top-level `opencode.json` field — `opencode.json` is strictly schema-validated and an unrecognized top-level key is a hard error that blocks the entire config from loading (confirmed live). The tuple's second element is opencode's own explicitly-unvalidated escape hatch for plugin options:

```json
{
  "plugin": [
    ["opencode-squad@git+https://github.com/GFN-CIS/opencode-squad.git", {
      "rate_limit_guard": {
        "enabled": true,
        "retry_on_errors": [429, 403],
        "retryable_error_patterns": ["rate.?limit", "usage.?limit", "quota", "blocked by a gateway or proxy"],
        "max_wait_seconds": 3600,
        "max_cumulative_seconds": 3600,
        "max_silence_seconds": 600
      }
    }]
  ]
}
```

All fields are optional — the values above are also the defaults, so omitting `rate_limit_guard` entirely (or using the plain-string plugin form) behaves the same.

- `max_wait_seconds` — a **single** announced wait longer than this (e.g. a provider saying "resets in 7 days") aborts immediately. Don't wait at all.
- `max_cumulative_seconds` — no single wait was long, but retries keep accumulating (repeated short backoffs) past this total — abort once the sum crosses it.
- `max_silence_seconds` — abort a guarded subagent that has produced **zero activity at all** for this long, regardless of whether opencode ever surfaced a retry or error event for it (see signal 3 below). 10 minutes by default: long enough that a legitimately slow first token (heavy reasoning models can take a couple minutes before streaming anything) won't false-positive, short enough that it doesn't cost the orchestrator the better part of an hour before it finds out.
- `retry_on_errors` / `retryable_error_patterns` — same idea as [`@renjfk/opencode-model-fallback`](https://github.com/renjfk/opencode-model-fallback)'s options: only intervene on retries that actually look like a rate/usage limit (matched against opencode's own retry message, or a cached HTTP status code), not on ordinary transient 5xx blips — those are left to opencode's normal backoff.
- Only ever applies to **subagent** sessions (anything with a parent) — a top-level/human chat session is left alone; run `opencode-model-fallback` alongside this if you want that case covered too.

Three independent signals feed the guard, so it also catches failures that never look like a retry to opencode itself:

1. **`session.status` retry events** — the abort path. Once a threshold trips, the plugin aborts the stuck subagent. The `task` tool's own error text for that is opencode's hardcoded `"Task cancelled"` (there's no API to set custom text there — confirmed empirically). To actually carry the reason and the "switch models" instruction, once the orchestrator's turn goes idle again the guard sends it a plain follow-up message explaining what happened and telling it to pick a different grunt/drill and retry — including an absolute `Rate limited till <ISO datetime>` deadline when the provider announced one, or `unknown` when it didn't (never a vague "wait a bit").
2. **Terminal `session.error`/`message.updated` failures** — not every limit produces a retry signal. A real provider error like `"Your token-plan quota has been exhausted"` matches none of opencode's own built-in retryable-message patterns, so opencode never schedules a retry for it at all and the call just fails outright with no warning. The guard also matches these directly against the same patterns and sends the same explanatory note, even though there was nothing for it to abort.
3. **Silence polling backstop** — the other two signals both require opencode to emit a specific event. Verified live against a real quota-exhausted provider: opencode's ai-sdk layer retried the call *internally* for 10+ minutes without ever emitting a `session.status:retry` or `session.error` — neither of the two paths above ever gets a chance to fire. The guard runs an independent timer per subagent session, polling for any message/part activity; if a guarded session goes completely silent past `max_silence_seconds`, it's aborted on the wall clock alone, no event required.

Verified live end-to-end against a genuinely quota-exhausted model, on two separate occasions: the guard caught the limit, told the orchestrator, and the orchestrator switched to a different grunt on its own — then, when that one turned out to share the same exhausted account, switched again to a different provider entirely, all without being told which model to pick. The silence backstop specifically was confirmed against a live subagent that produced zero events for over 10 minutes.

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

- **Read-only / investigation** (status checks, "why is X", log/metric digs) → delegate execution to a per-model `grunt-*` (or a specialized read agent like `Explore`) with **no drill** — there is no artifact to review. The orchestrator sanity-checks the findings itself, then reports.
- **Changes** (code / docs / config) → the full PDCA loop:
  1. **Plan / Do** — calls a `grunt-*` with the brief, definition of done, context, and (from iteration 2 onward) the drill's feedback.
  2. **Check** — calls the matching `drill-*` with the brief and the grunt's output. The drill returns a strict JSON verdict: `{"verdict": "PASS"|"FAIL", "checks": [...], "issues": [...], "suggested_fixes": [...], "blocking": <bool>}`.
  3. **Act** — on `PASS`, the orchestrator runs a final sanity-check (e.g. tests/lint) and delivers the result. On `FAIL`, it retries — up to **3 iterations total**, then escalates to the user rather than retrying blindly.

### Matching the delegate (capability & risk)

Delegating only helps if the delegate is actually fit for the task. The injected inventory lists each subagent's model, and the orchestrator weighs two things before handing work over:

- **Capability** — the orchestrator routes by what the *specific* models involved are good and bad at as of the current date (its own model and each subagent's model are in the bootstrap/inventory), rather than from fixed rules. High-cognition work (analysis, architecture, ambiguous trade-offs) is not handed to the cheapest drafted `grunt-*`, where a weak model would produce confident nonsense — it picks a strong-model delegate or keeps the task itself. **This cuts both ways:** when the orchestrator itself runs on a mid/cheap model and a task (or a pivotal call inside it) is beyond its depth, it escalates *up* — delegating the whole task to a stronger grunt, or consulting one for a second opinion before committing (advisor-style), rather than guessing.
- **Risk / blast radius** — for production writes, destructive operations, and migrations, investigation and a dry-run plan may be delegated, but the **apply step is never blind**: the orchestrator surfaces the exact plan/commands, waits for your explicit confirmation, and only then applies. An unsupervised prod-write is never handed to the cheapest `grunt-*` (its broad `bash`/`edit` permissions would execute it without a second opinion).

### Weighing real cost (caching, subscriptions, context)

Delegation isn't automatically the cheap option — three factors can flip it:

- **Prompt/KV caching** — a fresh `grunt-*` session starts with no cache hit on your accumulated context, while continuing yourself on a provider with prompt caching reuses your already-cached prefix at a steep discount. For a small task on top of a large, already-cached context, finishing it yourself can beat the cost of writing a brief, spinning up a grunt cold, and reading its result back.
- **Subscription vs API billing** — a grunt marked `billing: subscription` in `model_data.json` (see above) costs the user ~$0 marginally regardless of tokens; an API-billed grunt's cost scales with usage. When quality is comparable, the orchestrator prefers the subscription-covered delegate and saves API-billed models for when they're genuinely the better fit — not by default.
- **Context pressure is not a panic button** — the live `<ORCHESTRATE_CONTEXT>` line is for genuinely heavy work, not an excuse to delegate every minor task once usage looks high. opencode compacts automatically, and for small/quick work the overhead of a task brief plus a grunt round-trip usually costs more than just doing it and letting compaction absorb the overflow.

For full routing rules, escape hatches, and edge-case handling see [skills/squad-delegate/SKILL.md](skills/squad-delegate/SKILL.md).

---

## Forcing a mode

The verdict is the model's call, but you steer it directly:

- **Force SELF** — say *"do it yourself"* (or "делай сам") in your request. This is a first-class override: the orchestrator skips delegation entirely.
- **Force DELEGATE** — just say *"delegate this"* / *"делегируй"*. The orchestrator follows the instruction even when a task would otherwise look trivial.
- **Force a specific subagent** — name it: *"delegate to `Explore`"*, *"use `grunt-anthropic-claude-sonnet-5`"*. Naming one is decisive.
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

`grunt-*` and `drill-*` do not appear in the `@` mention menu because they are registered with `hidden: true`. They are invoked internally by the orchestrator. If you need to verify they are registered, use a one-off session and ask the model to list available subagents (it can introspect the session state).

**Orchestrator says there's no squad**

There is no bundled grunt/drill fallback agent — if `~/.config/opencode/agent/` (or a project's `.opencode/agent/`) has no `grunt-*`/`drill-*` files, the bootstrap tells sarge to send you to the `squad-draft` skill instead of delegating. Run it once and reload.

**Check which mode it chose**

The orchestrator prints its verdict (`SELF: …` / `DELEGATE: …`) as the first line of its reply. If it delegated when you wanted it to act itself, prepend "do it yourself" to your request; if it acted itself when you wanted delegation, say "delegate this". See [Forcing a mode](#forcing-a-mode).

**Iteration cap and cost**

A full PDCA iteration (the *changes* branch) fires two LLM calls (grunt + drill) on top of the orchestrator's own context. On a complex task with 3 iterations that is potentially 7+ model calls. Read-only / investigation delegations skip the drill, and trivial tasks are handled by the orchestrator directly — so cost scales with task weight, which is what the selection signals (and the live context line) are there to gauge.

---

## Development

```bash
npm install
npm test          # vitest — unit suite for src/ (bootstrap, inventory, context, benchmarks, model-data, workers, rate-limit-guard)
npm run coverage  # vitest + @vitest/coverage-v8, scoped to src/**; CI-gated at 80% (statements/branches/functions/lines)
npm run lint      # biome check — formatting + lint
npm run lint:fix  # biome check --write
npm run knip      # unused files/exports/dependencies
```

Coverage is scoped to `src/**` on purpose — that's the pure decision-logic layer the codebase deliberately separates from `.opencode/plugins/orchestrate.js`'s SDK-client/event plumbing (see that file's header comment). Unit-testing the plugin file itself would mean mocking the whole opencode SDK client.

---

## License

MIT — see [LICENSE](LICENSE).
