# ADR-0009: The role prompt is the plugin's bundled file, applied on every request

Status: accepted

## Context

Each model gets its own grunt and drill, all sharing one role prompt per role. The plugin runs for days in a long-lived service, and the role prompts change between releases and during development. When the agents were files, each held a copy of the prompt, and the copies drifted silently until someone re-ran `squad-draft`.

## Decision

The registered agent carries a fenced placeholder that names its role. On every request of a squad agent the plugin's `context` hook replaces the fenced text with the current `prompts/<role>.md` of the running plugin. The placeholder itself tells the agent to stop and report a broken install if the plugin is absent. Nothing volatile goes into the prompt.

## Rejected alternatives

- Copy the prompt into the agent at registration only: an edit needs a re-register to take effect.
- A full prompt as fallback inside the placeholder: two states, and the file no longer shows what the model received.

## Consequences

- An edit of `prompts/<role>.md` reaches every squad agent on its next request.
- A user agent without the fence is never touched.

Satisfies RFC 0001: GOAL-1, FR-008, FR-011. Details: `src/prompt-inject.js`.
