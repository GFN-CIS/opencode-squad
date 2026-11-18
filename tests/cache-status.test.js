import { expect, test } from "vitest";
import { ASSUMED_CACHE_TTL_SECONDS, resolveCacheTtl } from "../src/cache-status.js";

test("resolveCacheTtl returns published figures for providers that publish one", () => {
  expect(resolveCacheTtl("anthropic")).toEqual({ seconds: 300, source: "published" });
  // Not flattened to 300: a flat default would call a warm 30-min OpenAI
  // session cold.
  expect(resolveCacheTtl("openai")).toEqual({ seconds: 1800, source: "published" });
});

test("resolveCacheTtl falls back to the assumed floor, always with a number", () => {
  for (const p of ["alibaba-token-plan", "totally-unknown", undefined, ""]) {
    expect(resolveCacheTtl(p)).toEqual({
      seconds: ASSUMED_CACHE_TTL_SECONDS,
      source: "assumed",
    });
  }
  expect(ASSUMED_CACHE_TTL_SECONDS).toBe(300);
});

test("resolveCacheTtl is not fooled by inherited Object.prototype keys", () => {
  expect(resolveCacheTtl("constructor")).toEqual({ seconds: 300, source: "assumed" });
  expect(resolveCacheTtl("toString")).toEqual({ seconds: 300, source: "assumed" });
});

test("resolveCacheTtl prefers a published figure over our own measurement", () => {
  // We measured ~300 for openai, but 1800 is the vendor's published retention;
  // a regression of their behaviour must not overrule their own number.
  expect(resolveCacheTtl("openai")).toEqual({ seconds: 1800, source: "published" });
});

test("resolveCacheTtl falls to measured values where nothing is published", () => {
  expect(resolveCacheTtl("zai")).toEqual({ seconds: 600, source: "measured" });
  expect(resolveCacheTtl("zai-coding-plan")).toEqual({ seconds: 600, source: "measured" });
  // Measured at the same number as the floor, but the label is now earned.
  expect(resolveCacheTtl("github-copilot")).toEqual({ seconds: 300, source: "measured" });
});

test("resolveCacheTtl keeps the floor for providers we could not measure", () => {
  // alibaba: 5 sessions total. google: no sample anywhere past 5m.
  expect(resolveCacheTtl("alibaba-token-plan")).toEqual({ seconds: 300, source: "assumed" });
  expect(resolveCacheTtl("google")).toEqual({ seconds: 300, source: "assumed" });
});
