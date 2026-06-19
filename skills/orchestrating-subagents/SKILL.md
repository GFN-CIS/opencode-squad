---
name: orchestrating-subagents
description: Use when deciding whether to delegate a user's task to subagents and how to run the worker/reviewer PDCA cycle - covers the delegation decision, task-brief and definition-of-done contracts, verdict routing, the iteration cap, and the final sanity-check.
license: MIT
---

# Orchestrating Subagents (PDCA)

You are an orchestrator running a Deming/PDCA loop over subagents. This skill is
orthogonal to other skills: the worker and reviewer use their own skills inside
their own sessions. Your job is to decide, delegate, and route.

## 1. Decide: yourself or delegate?

State one explicit verdict before acting. Default to delegating — your value is
decomposition and review, not routine work on an expensive model.

**DELEGATE** when ANY of these holds (the default for real work):
- the task needs external access (ssh, kubectl, grafana, web, repo-wide search),
- it would take more than ~3 tool steps, or
- it produces an artifact (code, docs, config).

**SELF** only when:
- the user said "do it yourself", or
- it is pure Q&A / explanation, or a single trivial read.

When user-defined specialized subagents exist (see the injected inventory) and
one fits the task better than the generic `worker`, prefer it.

## 1a. Pick the delegation shape

- **read-only / investigation** (status checks, "почему X", log/metric digs) →
  delegate execution to `worker` (or a specialized read agent like `Explore`)
  with **NO reviewer** — there is no artifact to review. Sanity-check the
  findings yourself, then report.
- **changes** (code / docs / config) → run the full PDCA cycle below.

## 2. Formulate the work

Before calling the worker, write:
- a **task brief** (what to do),
- a **definition of done** in free form: how you will know it was done well,
  tailored to the task domain (code, docs, research, creative, …),
- the relevant **context**,
- the **return format** you want.

## 3. The cycle (max 3 iterations) — changes branch

This full worker→reviewer loop is for the **changes** branch. For read-only /
investigation, skip the reviewer (see §1a) and go straight to your own
sanity-check.

For iteration N = 1..3:

1. Invoke `worker` (via the task tool) with: task brief, definition of done,
   context, return format, and — if N > 1 — the previous reviewer feedback.
2. If the worker returns empty/garbage, treat it as FAIL without calling the
   reviewer; retry with "previous attempt returned no usable output".
3. If the worker reports it lacks access/information, escalate to the user — do
   not auto-retry.
4. Otherwise invoke `work-reviewer` with: task brief, definition of done, and
   the worker's result verbatim. The reviewer returns strict JSON.
5. If the reviewer returns non-JSON, retry it once with "STRICT JSON ONLY". If
   it fails again, review the work yourself.

## 4. Route the verdict

- `verdict = PASS` → exit the loop, then run a **final sanity-check yourself**
  (a quick own check — e.g. run tests/lint if applicable — not another review).
  If your sanity-check finds problems the reviewer missed, fix them yourself and
  note it.
- `verdict = FAIL` and N < 3 → iteration N+1, passing the reviewer feedback to
  the worker.
- `verdict = FAIL` and N = 3 → stop and escalate to the user: show what exists
  and ask how to proceed.
- Two consecutive FAILs on the same fundamental blocker → take control: either
  finish it yourself or escalate. This signals the brief/DoD was poorly formed.

## 5. Escape hatches

You may abort the cycle at any point and finish the work yourself if delegation
turns out to be the wrong call mid-flight. Do not dogmatically complete the loop.

## 6. Transparency

In your final answer to the user, briefly state the delegation outcome, e.g.
"delegated to worker (2 iterations), reviewer approved".
