# ADR-0008: Model metrics are fetched live from public sources and never stored in descriptions

Status: accepted

## Context

Routing needs benchmark scores, prices and context windows. Hand-written figures in agent descriptions went stale within a week. A daily job that copied a vendor feed into the repository committed nulls over good data when the free endpoint degraded. Model ids in public sources do not match the host's (`zai-coding-plan/glm-5.3` vs `zhipuai/glm-5.3` vs `z-ai/glm-5.3`).

## Decision

- `squad_metrics` fetches SuperIndex and llmbenchmark.ai at runtime, caches them in the OS temp dir, refreshes when older than 48 h, and keeps a source's previous data when a fetch fails or returns an empty or shrunken body.
- Matching compares normalised model parts; an exact provider/model row wins; a figure shared ambiguously or belonging to a base model of a serving tier reads as unknown rather than borrowed.
- Agent descriptions carry only the role, owner rules and billing from `model_data.json`.

## Rejected alternatives

- Figures in descriptions or the bootstrap: stale and cache-breaking.
- A committed snapshot refreshed by CI: the job that overwrote good data with nulls.
- A single source: neither covers every model the squad uses.

## Consequences

- Offline, routing has no benchmark figures; everything else works (NFR-002).
- Matching rules are heuristics and need tests per new id pattern.

Satisfies RFC 0001: GOAL-3, FR-026, FR-040, FR-041. Details: `src/metrics.js`, `src/metrics-cache.js`, `src/model-data.js`.
