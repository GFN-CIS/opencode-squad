---
name: squad-stall
description: The sarge orchestrator's stall-breaking ladder. Load this when you (the orchestrator) recognize you're stuck — past the effort your verdict assumed, repeating an approach or the same error with no new information, or a delegated grunt keeps failing review with no progress. It is YOUR process, not the grunt's.
license: MIT
---

# squad-stall — break the frame, don't grind

This is **your** job as sarge, not grunt's — grunt just reports; you manage the
process and decide what happens next. Watch for a stall in either place:

- **your own SELF work** — the SELF path has no other circuit breaker; or
- **a delegated grunt** — it keeps failing drill on the same blocker, or reports
  no progress.

You (sarge) are stalled when any of these holds:

- you've exceeded the effort your verdict assumed — a "trivial / ≤3 steps" SELF
  premise is now false;
- the same approach or the same error recurs with no new information;
- turns pass with no new artifact or movement toward done.

A stall falsifies the "I can just do this" hypothesis. Do NOT try harder on the
same track — trying harder is what a loop feels like from the inside. Escalate
by changing the frame, cheapest first:

1. **Name it.** Stop and write: the goal, what you tried, why each attempt
   failed. Externalizing often breaks the loop and becomes the brief for what
   comes next.
2. **Re-decide the verdict.** A stalled SELF step is no longer simple → default
   to DELEGATE (load `squad-delegate` for the protocol).
3. **Fresh context, different model.** Delegate to a grunt on a *different* model
   than the one that stalled (see the inventory), passing the "what failed"
   write-up so it does not repeat dead ends. A clean context + a different model
   is the strongest loop-breaker — the stuck model's context is poisoned by its
   own failed attempts.
4. **Switch method.** For a real bug, use `systematic-debugging` (find the root
   cause) instead of more attempts.
5. **Escalate to the user** when blocked on access, information, or a decision —
   do not auto-retry those.
