# ADR-0003: An agent at a squad id is the squad's only if the plugin built it or it is exactly a legacy file

Status: accepted

## Context

Users define agents in files and config, globally and per project. Earlier versions marked their files with a comment; a marked file proves who wrote the file, not who owns the id, because another source can define the same id and win. Hiding or replacing such an agent changes the user's configuration.

## Decision

An id belongs to the squad when the plugin built the agent there, or when the agent the host loaded there equals, field for field, what a legacy file alone yields (host defaults, the file's fields, its rules as a multiset). Only the last generator's format is modelled. Every other agent at a squad id is the user's: left as the host built it, its squad entry not registered, noted by `squad_dump`, refused by `squad_patch`. Registration and `squad_patch` use the same test.

## Rejected alternatives

- Trust the file marker: a project agent at the same id would be hidden.
- Compare prompt and model only: a user agent with the same prompt and its own description was treated as the squad's.
- Fixed probe id: a user agent with that name was removed with the probe.

## Consequences

- A user agent identical to a legacy file in every field is treated as the squad's (ASM-005).
- A legacy file in an older format never owns its id; the dump asks the user to delete it.

Satisfies RFC 0001: GOAL-7, FR-010 to FR-013, FR-016, FR-019. Details: `src/squad-agents.js`, `src/squad-apply.js`.
