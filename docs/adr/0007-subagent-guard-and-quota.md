# ADR-0007: Subagent-only rate-limit guard and quota notes, delivered to the parent session

Status: accepted

## Context

The host retries a rate-limited call for as long as the provider asks, up to weeks, with no configuration. A subagent in that state blocks the lead, which could pick another model. Some failures never look like a retry: a terminal error, or a stream that goes silent. Providers also report how much of their rate-limit window is used on every successful response, and the host discards it.

## Decision

- The guard acts only on sessions with a parent. It vetoes a retry through the host's `retry` hook when one announced wait or the sum of waits passes a threshold, reacts to terminal errors matching the guard patterns, and interrupts an execution silent past a threshold, rearmed on every resume.
- Each event sends exactly one note to the parent session, with the reset time when known, the actual interrupt outcome, and a warning about side effects.
- Quota headers are read from subagent responses through the `http.response` hook. A note goes to the parent only when the binding window enters a higher band or the provider switches to rejected.

## Rejected alternatives

- Act on top-level sessions too: a person is watching those; other plugins cover the case.
- Wrap `globalThis.fetch` for quota: saw no model requests, because the OAuth plugin sets its own fetch.
- Inject `provider.options.fetch`: displaced the OAuth plugin's token injection and hung sessions.
- A note on every response: repeats the same figure on every call.

## Consequences

- Providers that send no quota headers get no quota note (ASM-003).
- Thresholds are configuration (CON-006, CON-007).

Satisfies RFC 0001: GOAL-4, GOAL-3, FR-034 to FR-039. Details: `src/rate-limit-guard.js`, `src/quota.js`.
