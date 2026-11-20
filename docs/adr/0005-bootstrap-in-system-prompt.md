# ADR-0005: The lead's bootstrap lives in the system prompt and is byte-stable

Status: accepted

## Context

The lead needs its role, its own model and the squad inventory on every request. Earlier versions injected that block, with the current time and context size, into the latest user message on every request. Each cached prefix past the system prompt then contained a user message with the block, which reverted to bare text on the next turn: every warm turn re-wrote the whole conversation to the cache, about $299 of $869 over 14 days of measured sessions.

## Decision

The bootstrap is appended to the lead's system prompt only, and changes only with the squad or the lead's model. It carries no clock, context size, benchmark or price. The time and context size come from `squad_session` with no arguments; benchmarks from `squad_metrics`. Messages are never modified. Subagent requests get no bootstrap.

## Rejected alternatives

- Inject into the latest user message: breaks the cache every turn (measured above).
- Put numbers in agent descriptions: they go stale while looking authoritative; a lead asked to refresh them invented figures.

## Consequences

- The lead must call `squad_metrics` once per chat before routing.
- Anything added to the bootstrap must stay stable between turns.

Satisfies RFC 0001: GOAL-6, FR-029 to FR-033. Details: `src/bootstrap.js`, `src/v2/adapt.js`.
