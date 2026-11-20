# ADR-0002: Squad agents are built after the host applies the user config, with role rules last

Status: accepted

## Context

The host's config plugin appends the user's global permission rules to every agent that exists when it runs, and evaluation is last match wins. A transform the plugin registers at setup runs before the config plugin. Built there, a drill would get the user's `allow *` after its own deny rules and lose its read-only policy. A user agent at a squad id would also receive squad fields.

## Decision

Registration runs in two phases.
- At setup the plugin creates only a probe agent with a random id; the config plugin appends the global rules to it.
- A late transform, registered before the first request selects an agent and again on every plugin reload, reads the global rules off the probe, removes the probe, and builds each squad agent from the host's defaults: global rules first, role rules last.
- Before the late transform has run, squad agents do not exist and a request for one fails.
- On each squad agent request the plugin checks that role rules are still last. If not, it re-registers the late transform and removes denied tools from that request's catalog.

## Rejected alternatives

- Register squad agents at setup: they run before the config plugin, so role rules end up first and lose.
- Copy the user's global rules by reading config files: a second parser of the host's config, which drifts.
- Deny by tool list instead of permissions: the host hides tools by permission rules; a parallel list would disagree with them.

## Consequences

- A request in the moment between dispose and re-register fails instead of running with wrong rules (ASM-006).
- The plugin depends on host ordering verified on one release (ASM-002); the integration tests pin that release.

Satisfies RFC 0001: GOAL-2, FR-003 to FR-007, FR-010, FR-011. Details: `src/squad-agents.js`.
