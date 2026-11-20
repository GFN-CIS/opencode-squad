# ADR-0006: Session facts are pulled through squad_session, not appended to subagent results

Status: accepted

## Context

To decide whether to reuse a subagent session the lead needs its cache state, context size, and the cause of an empty result. Since OpenCode 2.3 every `subagent` call runs in the background: the tool result is a stub, and the real result arrives later as a message no tool hook sees. A note on the stub described the session before the dispatch, and a timestamp in a note is wrong a turn later.

## Decision

`squad_session` takes the session ids the lead already holds and computes, at call time, whether the cache is warm or cold with seconds left or elapsed, the TTL's source, the context size, whether it still runs, and the cause of an empty or truncated result. Without ids it returns the time and the caller's context size. TTLs come from the user's `model_data.json`, then a published table, then local measurement, then a 300 s floor, each labelled.

## Rejected alternatives

- Notes on the `subagent` result: describe the wrong moment (above).
- "TTL not published, judge yourself": read as no expiry.
- A flat floor for all providers: calls a warm 30-minute OpenAI session cold.

## Consequences

- The lead must ask; nothing is pushed.
- Measured TTLs go stale; the measurement script is manual (ASC-2).

Satisfies RFC 0001: GOAL-3, FR-042 to FR-044. Details: `src/session-status.js`, `src/cache-status.js`, `src/task-outcome.js`, `src/compact.js`.
