# ADR-0004: The roster is edited as data: dump, edit, patch with revision, under a lock

Status: accepted

## Context

The roster generator once took a declarative list and pruned everything else. Asked to add one model, a caller passed one id and the squad was wiped; the protocol was followed exactly. Later two sessions, or two OpenCode processes sharing a config dir, could each dump, edit and write, and the second write erased the first.

## Decision

- `squad_dump` returns the roster and its revision, a content hash of `squad.json`; `squad_patch` writes a whole roster back and must carry that revision.
- A patch that removes an agent is refused unless `allow_remove` is set; nothing is written, not even its additions.
- The read, the revision check, the deletion guard, the ownership check and the write run synchronously under an exclusively created `squad.json.lock`. A lock held by someone else is never taken over; release removes only the lock this call created.
- Other processes notice a change by content, not size or timestamps.
- Subagents may not patch.

## Rejected alternatives

- A CLI beside the tools: it was the path that wiped a squad, and a second entry point needs a second copy of the guard.
- Last writer wins: silently reverts a concurrent edit.
- Taking over a stale lock: removing it by path can remove a fresh lock another process just created, and both write.
- Change detection by mtime and size: an equal-size edit within one timestamp tick is missed.

## Consequences

- A lock left by a crash blocks patches until the user deletes it (ASM-004).
- Every patch costs a dump first.

Satisfies RFC 0001: GOAL-5, FR-016 to FR-024. Details: `src/roster.js`, `src/squad-store.js`, `src/squad-apply.js`.
