# ADR-0001: The roster is one JSON file; agents are registered through the agent API

Status: accepted

## Context

The host dispatches subagents by agent id, so each model needs one agent per role. Versions before 0.6.0 wrote those agents as Markdown files in the global agent dir. The host also loads that dir's siblings and follows links, so one file could be reached under several ids. Every write, prune and migration risked changing another agent; four rounds of fixes added a shared-destination scan, ownership markers and a mirror of the host's loader, and each round found another path.

## Decision

The roster lives in `squad.json` in the OpenCode config dir, written only by the plugin. The plugin builds the squad agents in memory through the host's agent API on every load. No agent file is written, pruned or migrated. Files from older versions are imported once and left for the user to delete.

## Rejected alternatives

- Keep agent files and harden the writer further: every fix mirrored more of the host's loader, and the mirror drifted from the host.
- One file per agent under a plugin-owned dir: the host still reads agent dirs by its own rules, so aliasing stays possible.
- Agent entries in `opencode.json`: that file is the user's; rewriting it has the same ownership problem in a single file.

## Consequences

- The roster is global; per-project squads are not possible (OOS-4).
- A user agent at a squad id simply wins; there is nothing on disk to protect.
- The plugin must be loaded for the squad to exist; there is no fallback agent.

Satisfies RFC 0001: GOAL-5, GOAL-7, FR-001, FR-002, FR-010, FR-014, FR-023. Details: `src/squad-store.js`, `src/squad-agents.js`.
