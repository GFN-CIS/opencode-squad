---
name: squad-redteam
description: Use when the user wants a cross-model red-team / second-opinion review — dispatch the SAME artifact or question to several grunts in parallel (different providers/models) and have sarge cross-analyze their independent findings into one consolidated report. Mirrors @alexmkx/opencode-multi-delegate's parallel-dispatch-and-consolidate pattern, but reuses the already-drafted `grunt-*` squad instead of a separate delegate config. Uses grunts, not drills — the panel needs live MCP/gitlab/webfetch access to actually pull the artifact (diffs, external rule docs), and drills are read-only. ALWAYS let the user pick which grunts run, via the multi-select question tool, defaulting to the single strongest grunt per provider. Triggers — "redteam", "red team this", "cross-review", "second opinion from other models", "перепроверь другими моделями", "устрой редтим", "кросс-ревью".
license: MIT
---

# squad-redteam — parallel cross-model review, consolidated by sarge

One model can rubber-stamp or hallucinate. This skill dispatches the same
artifact/question to **several grunts on different models/providers at once**
and has you (sarge) cross-analyze their independent findings — agreement
across models is much stronger evidence than one model's say-so. Same idea as
`@alexmkx/opencode-multi-delegate`, adapted to reuse the squad's own `grunt-*`
agents (already scaffolded by `squad-draft`) instead of a standalone
delegate-model config — no new agents, no new config file.

**Grunts, not drills.** `drill-*` is read-only (`bash: deny`) — fine for
reviewing an artifact already in front of you, useless for a task that needs
to go *fetch* the artifact itself (a GitLab MR's diffs via MCP, an external
rules doc via webfetch, a repo to clone/grep). This skill's panel is
`grunt-*`, used purely as parallel **analysts** for this pass — see the
`<CRITICAL>` block below for the guardrail that keeps them from "fixing"
anything they find.

**You stay the analyst-in-chief.** You dispatch and cross-check; you do not
investigate the artifact yourself in this pass (that's what the panel is
for), and you do not silently trust a majority — 3 models agreeing on a
hallucination is still a hallucination if none of them show real evidence.

<CRITICAL>
The moment this skill is loaded, you are in redteam mode until dispatch. Until
step 3's `task` calls are sent:
- You MUST NOT use `read`, `grep`, `glob`, `bash`, `webfetch`, `mcpproxy_*`, or
  any other investigation tool to look at the artifact yourself. That is the
  panel's job, not yours — self-investigating here defeats the entire point of
  a cross-model check and is exactly the failure mode this skill exists to
  prevent.
- You MUST NOT invent or assume what's being reviewed. If it isn't already
  unambiguous from the conversation (a diff/file/claim/URL explicitly in
  view), **ask the user what to red-team before doing anything else.** Do not
  fall back to "whatever seems to be the current task" — a wrong guess here
  means every panel member reviews the wrong thing.
- The only tools you may use before dispatch are the discovery commands in
  step 1 (listing agent files, reading model_data/benchmarks) and the
  multi-select question tool.

And every dispatched grunt gets told, verbatim, in its task brief (step 3):
**investigation only — do NOT edit, write, or modify any file, do NOT open a
commit/MR/PR, do NOT run destructive or mutating commands.** A grunt's default
instinct is to fix what it finds; this pass is read-only by contract, not by
permission (grunts *can* edit — you must tell them not to).
</CRITICAL>

## 0. Prerequisite

This needs an existing `grunt-*` squad. Check for one yourself (see step 1's
discovery) rather than trusting a live inventory that may not have reached you
this turn. If there are no `grunt-*` agents, tell the user to run `squad-draft`
first.

## 1. Pick the panel

1. **Discover the grunts yourself — don't rely on the bootstrap inventory
   having arrived this turn.** Read the source of truth directly:
   ```bash
   ls ~/.config/opencode/agent/grunt-*.md .opencode/agent/grunt-*.md 2>/dev/null
   ```
   Each file's frontmatter has a `model:` line (`provider/model`). Group the
   grunts by the provider segment of the filename (`grunt-<provider>-...`).
2. Within each provider group, rank by AA intelligence. Check, in order:
   - `.opencode/model_data.json` (project) or `~/.config/opencode/model_data.json`
     (global) — `.models["<provider/model>"].intelligence`;
   - else the plugin's static AA snapshot:
     `find ~/.cache/opencode/packages -path '*node_modules/opencode-squad/src/benchmarks.json'`
     (or the repo's own `src/benchmarks.json` if you're running from a checkout).
   Pick the highest-intelligence grunt per provider as the pre-checked default
   — one strongest grunt per provider, not the whole roster. If neither source
   is available, default to any one grunt per provider and say the ranking is
   unavailable.
3. **Ask, don't assume.** Present all available grunts as a multi-select
   question (use the built-in interactive question tool — checkboxes,
   `multiple: true`), each grunt labeled with its model and, if you have it,
   a one-line capability hint (intel/code/agentic/$), with the per-provider
   defaults above pre-checked. Let the user add or remove any grunt freely
   (e.g. run every grunt from one provider, or add a cheap one for a
   fast/rough pass). Do not skip this ask even when the default looks
   obviously right — panel composition is the user's call.
4. If the user picks zero grunts, fall back to the computed defaults and say
   so; do not abort.

## 2. Pin down what's being red-teamed

Confirm the exact artifact or question in one line before dispatching — an MR
URL, a design/plan, a specific claim, a set of external rule docs to check
against. **If it's ambiguous, you MUST ask — never guess or substitute your
own idea of "the current task."** Do not paraphrase or trim it before sending;
every panel member gets the identical brief so their findings are actually
comparable.

## 3. Dispatch (parallel, identical brief)

For each selected grunt, invoke it via the `task` tool — **all calls in one
message**, never sequential. Every grunt gets the SAME:
- task brief (what to fetch and look at — URLs, MR links, rule docs, verbatim),
- the investigation-only guardrail from the `<CRITICAL>` block above,
- definition of done, reframed for red-teaming, e.g. "surface every
  correctness/security/design/rule violation you can find, with concrete
  evidence" — break it into the concrete checks that make sense for what's
  being reviewed,
- the **required output format** (grunt has no fixed report contract like
  drill's JSON — you must specify it explicitly):
  ```
  Return your results as a structured list of findings:

  ### Findings
  1. **[Short finding title]**
     - Description: [what exactly, where, why it matters]
     - Severity: critical | important | minor | info
     - Evidence: [concrete — file, line, quoted rule, quoted diff]
     - Recommendation: [what to do about it]
  2. ...

  ### Summary
  [1-2 sentences — overall verdict]
  ```

## 4. Cross-analyze (this is the point of the exercise)

Collect every grunt's findings. For each distinct issue across all reports:

1. **Group** — match findings describing the same underlying problem even if
   worded differently or at different severities.
2. **Attribute** — which grunts (and their models) raised it.
3. **Verdict**:
   - **confirmed** — 2+ independent grunts raise it (or one raises it with
     concrete, checkable evidence you've verified yourself) and the evidence
     holds up.
   - **disputed** — only one grunt claims it and you can't verify either way,
     or grunts explicitly contradict each other.
   - **rejected** — evidence doesn't hold under your own check, another grunt
     explicitly refutes it with better evidence, or it reads like a
     hallucination (vague, generic, unfalsifiable, or not actually present in
     the artifact).

Read evidence critically the same way `squad-delegate` §4 says to for a single
drill — a cheap-model grunt can rubber-stamp or invent "evidence" it never
checked; concrete file/line/value/quoted-rule citations count, generic
boilerplate doesn't. Spot-check at least the "confirmed" findings against the
actual artifact yourself before reporting them as such.

## 5. Report

```
## Red-team Report — panel: <grunt-a, grunt-b, grunt-c>

### Finding #1: [Title]
**Severity:** critical | important | minor | info
**Description:** [what, where, why it matters]
**Claimed by:** [which grunts/models]
**Verdict:** confirmed / disputed / rejected
[why]
**Recommendation:** [if any]

---

## Consensus
[what the panel agrees on]

## Disagreements
[where models diverged, and your read on why]

## Overall verdict
[your synthesized call — safe to proceed / needs fixes / needs a human call]
```

State plainly which grunts you ran (panel composition) and that this replaces
neither your own judgment nor, for actual changes, the normal grunt/drill PDCA
cycle in `squad-delegate` — this skill is a review/second-opinion tool, not an
execution path.
