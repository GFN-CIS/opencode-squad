// Suite: createTurnMemo (src/message-transform.js) — the bounded per-turn
// cache that keeps an injected block byte-stable across the requests of one
// turn so the provider prompt cache survives. Covers get/set, concurrent-turn
// isolation and eviction at the bound. Not covered: the transform that fills
// and replays the memo (applyOrchestratorTransformV2 in src/v2/adapt.js,
// exercised in tests/v2-adapt.test.js). Run: npx vitest run tests/turn-memo.test.js

import { expect, test } from "vitest";
import { createTurnMemo } from "../src/message-transform.js";

test("memo returns the exact turn block and isolates concurrent turns", () => {
  const memo = createTurnMemo();
  const a = { bootstrap: "A", contextLine: "context A" };
  const b = { bootstrap: "B", contextLine: null };
  expect(memo.get("missing")).toBeNull();
  memo.set("a", a);
  memo.set("b", b);
  expect(memo.get("a")).toBe(a);
  expect(memo.get("b")).toBe(b);
});

test("memo evicts only the oldest turn at its bound", () => {
  const memo = createTurnMemo(2);
  memo.set("a", { bootstrap: "A", contextLine: null });
  memo.set("b", { bootstrap: "B", contextLine: null });
  memo.set("c", { bootstrap: "C", contextLine: null });
  expect(memo.get("a")).toBeNull();
  expect(memo.get("b")?.bootstrap).toBe("B");
  expect(memo.get("c")?.bootstrap).toBe("C");
});
