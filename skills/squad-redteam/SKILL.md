---
name: squad-redteam
description: Use when the user wants a cross-model red-team / second-opinion review — dispatch the SAME artifact or question to several drill reviewers in parallel (different providers/models) and have sarge cross-analyze their verdicts into one consolidated report. Mirrors @alexmkx/opencode-multi-delegate's parallel-dispatch-and-consolidate pattern, but reuses the already-drafted `drill-*` squad instead of a separate delegate config. ALWAYS let the user pick which drills run, via the multi-select question tool, defaulting to the single strongest drill per provider. Triggers — "redteam", "red team this", "cross-review", "second opinion from other models", "перепроверь другими моделями", "устрой редтим", "кросс-ревью".
license: MIT
---

# squad-redteam — parallel cross-model review, consolidated by sarge

One drill can rubber-stamp or hallucinate. This skill dispatches the same
artifact/question to **several drills on different models/providers at once**
and has you (sarge) cross-analyze their independent verdicts — agreement
across models is much stronger evidence than one model's say-so. Same idea as
`@alexmkx/opencode-multi-delegate`, adapted to reuse the squad's own `drill-*`
agents (already scaffolded by `squad-draft`) instead of a standalone
delegate-model config — no new agents, no new config file.

**You stay the analyst-in-chief.** You dispatch and cross-check; you do not
review the artifact yourself in this pass (that's what the drills are for),
and you do not silently trust a majority — 3 drills agreeing on a hallucination
is still a hallucination if none of them show real evidence.

## 0. Prerequisite

This needs an existing `drill-*` squad. If the live inventory (in your
bootstrap) has no `drill-*` entries, tell the user to run `squad-draft` first
— do not fall back to the single generic `drill`, that defeats the point of a
cross-model check.

## 1. Pick the panel

1. Read the live inventory in your bootstrap and filter to `drill-*` agents.
   Group them by provider (the segment right after `drill-`, e.g.
   `drill-openai-gpt-5-5` → provider `openai`).
2. Within each provider group, pick the **default**: the single drill with the
   highest `AA intel` score in the inventory's capability tail (fall back to
   `AA code` if intel is missing, then to any drill in that group if neither is
   present). This is your pre-checked default — one strongest drill per
   provider, not the whole roster.
3. **Ask, don't assume.** Present all available drills as a multi-select
   question (use the built-in interactive question tool — checkboxes,
   `multiple: true`), each drill labeled with its model and a one-line
   capability hint (intel/code/agentic/$), with the per-provider defaults
   above pre-checked. Let the user add or remove any drill freely (e.g. run
   every drill from one provider, or add a cheap one for a fast/rough pass).
   Do not skip this ask even when the default looks obviously right — panel
   composition is the user's call.
4. If the user picks zero drills, fall back to the computed defaults and say
   so; do not abort.

## 2. Pin down what's being red-teamed

Confirm the exact artifact or question in one line before dispatching — a
diff, a design/plan, a specific claim, an investigation's conclusion, a piece
of code. If it's ambiguous (e.g. "redteam this" with nothing in view), ask
once. Do not paraphrase or trim it before sending — every drill gets the
identical brief so their verdicts are actually comparable.

## 3. Dispatch (parallel, identical brief)

For each selected drill, invoke it via the `task` tool — **all calls in one
message**, never sequential. Every drill gets the SAME:
- task brief (what to look at),
- definition of done, reframed for red-teaming, e.g. "no unaddressed
  correctness/security/design issue in this artifact" — break it into the
  concrete checks that make sense for what's being reviewed,
- the artifact/context itself, verbatim.

drill's contract is unchanged (see `prompts/drill.md`) — it still returns
strict JSON: `{"verdict", "checks", "issues", "suggested_fixes", "blocking"}`.
Do not ask it to free-form; the structured issues list is what you cross-
analyze in the next step.

## 4. Cross-analyze (this is the point of the exercise)

Collect every drill's JSON. For each distinct issue across all reports:

1. **Group** — match issues describing the same underlying problem even if
   worded differently or at different severities.
2. **Attribute** — which drills (and their models) raised it.
3. **Verdict**:
   - **confirmed** — 2+ independent drills raise it (or one raises it with
     concrete, checkable evidence you've verified yourself) and the evidence
     holds up.
   - **disputed** — only one drill claims it and you can't verify either way,
     or drills explicitly contradict each other.
   - **rejected** — evidence doesn't hold under your own check, another drill
     explicitly refutes it with better evidence, or it reads like a
     hallucination (vague, generic, unfalsifiable).

Read evidence critically the same way `squad-delegate` §4 says to for a single
drill — a cheap-model drill can rubber-stamp or invent "evidence" it never
checked; concrete file/line/value citations count, generic boilerplate
doesn't. A `blocking: true` from one drill and `verdict: PASS` from another on
the identical brief is itself a signal worth surfacing, not averaging away.

## 5. Report

```
## Red-team Report — panel: <drill-a, drill-b, drill-c>

### Finding #1: [Title]
**Severity:** high | med | low
**Description:** [what, where, why it matters]
**Claimed by:** [which drills/models]
**Verdict:** confirmed / disputed / rejected
[why]
**Suggested fix:** [if any]

---

## Consensus
[what the panel agrees on]

## Disagreements
[where models diverged, and your read on why]

## Overall verdict
[your synthesized call — safe to proceed / needs fixes / needs a human call]
```

State plainly which drills you ran (panel composition) and that this replaces
neither your own judgment nor, for actual changes, the normal grunt/drill PDCA
cycle in `squad-delegate` — this skill is a review/second-opinion tool, not an
execution path.
