import { expect, test } from "vitest";
import {
  bandOf,
  formatQuotaClause,
  parseQuotaHeaders,
  QUOTA_BANDS,
  shouldReport,
  windowLabel,
} from "../src/quota.js";

// Captured live on 2026-09-01 from POST api.anthropic.com/v1/messages -> 200.
const ANTHROPIC_200 = {
  "anthropic-ratelimit-unified-status": "allowed",
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-utilization": "0.07",
  "anthropic-ratelimit-unified-5h-reset": "1788258600",
  "anthropic-ratelimit-unified-7d-status": "allowed",
  "anthropic-ratelimit-unified-7d-utilization": "0.06",
  "anthropic-ratelimit-unified-7d-reset": "1788786000",
  "anthropic-ratelimit-unified-overage-status": "rejected",
};

// Captured live on 2026-09-01 from POST chatgpt.com/backend-api/codex/responses -> 200.
const CODEX_200 = {
  "x-codex-plan-type": "team",
  "x-codex-active-limit": "premium",
  "x-codex-credits-has-credits": "True",
  "x-codex-primary-used-percent": "51",
  "x-codex-primary-window-minutes": "300",
  "x-codex-primary-reset-at": "1788256708",
  "x-codex-secondary-used-percent": "15",
  "x-codex-secondary-window-minutes": "10080",
  "x-codex-secondary-reset-at": "1788758104",
};

// Captured live from POST api.z.ai/api/coding/paas/v4/chat/completions -> 200.
const ZAI_200 = {
  "alt-svc": 'h3=":443"; ma=3600',
  "ga-traceid": "4e27cf7c334caa3af6a684dc8a50a2e1",
  "x-log-id": "20260901152841c8b4ee440b82437d",
  "content-type": "text/event-stream;charset=UTF-8",
};

test("windowLabel names windows by length, not by the provider's ranking", () => {
  // codex re-ranks primary/secondary by whichever is closest to its limit, so
  // the label has to come from the duration.
  expect(windowLabel(300)).toBe("5h");
  expect(windowLabel(10080)).toBe("7d");
  expect(windowLabel(60)).toBe("1h");
  expect(windowLabel(0)).toBe("?");
  expect(windowLabel(Number.NaN)).toBe("?");
});

test("parseQuotaHeaders reads the live Anthropic block and trusts its binding claim", () => {
  const q = parseQuotaHeaders(ANTHROPIC_200);
  expect(q.windows).toEqual([
    { label: "5h", used: 0.07, resetAt: 1788258600 },
    { label: "7d", used: 0.06, resetAt: 1788786000 },
  ]);
  // representative-claim: five_hour -- the provider names it, we don't infer it
  expect(q.binding).toBe("5h");
  // overage-status: rejected is about overage billing, not about being blocked
  expect(q.blocked).toBeUndefined();
});

test("parseQuotaHeaders reads the live codex block and derives the binding window", () => {
  const q = parseQuotaHeaders(CODEX_200);
  expect(q.windows).toEqual([
    { label: "5h", used: 0.51, resetAt: 1788256708 },
    { label: "7d", used: 0.15, resetAt: 1788758104 },
  ]);
  expect(q.binding).toBe("5h"); // most consumed; codex never says which binds
  expect(q.plan).toBe("team");
  expect(q.creditsExhausted).toBeUndefined();
});

test("parseQuotaHeaders survives codex re-ranking its own slots", () => {
  // The August 429 shape: weekly was `primary` at 100%, the 5h slot zeroed out.
  const q = parseQuotaHeaders({
    "x-codex-primary-used-percent": "100",
    "x-codex-primary-window-minutes": "10080",
    "x-codex-primary-reset-at": "1787040730",
    "x-codex-secondary-used-percent": "0",
    "x-codex-secondary-window-minutes": "0",
    "x-codex-credits-has-credits": "False",
  });
  // Labelled 7d despite sitting in the `primary` slot; the zeroed slot dropped.
  expect(q.windows).toEqual([{ label: "7d", used: 1, resetAt: 1787040730 }]);
  expect(q.binding).toBe("7d");
  expect(q.creditsExhausted).toBe(true);
});

test("parseQuotaHeaders returns null when the provider reports no quota", () => {
  // z.ai genuinely sends nothing of the sort; that must produce no claim.
  expect(parseQuotaHeaders(ZAI_200)).toBeNull();
  expect(parseQuotaHeaders({})).toBeNull();
  expect(parseQuotaHeaders(null)).toBeNull();
  expect(parseQuotaHeaders("nope")).toBeNull();
});

test("parseQuotaHeaders flags an actually-rejecting provider", () => {
  const q = parseQuotaHeaders({
    ...ANTHROPIC_200,
    "anthropic-ratelimit-unified-5h-utilization": "1.0",
    "anthropic-ratelimit-unified-5h-status": "rejected",
  });
  expect(q.blocked).toBe(true);
});

test("bandOf stays silent below the first threshold", () => {
  expect(bandOf(0)).toBeNull();
  expect(bandOf(0.07)).toBeNull(); // the live Anthropic reading: nothing to say
  expect(bandOf(0.51)).toBeNull(); // the live codex reading: still nothing
  expect(bandOf(0.6)).toBe(0);
  expect(bandOf(0.85)).toBe(1);
  expect(bandOf(0.99)).toBe(2);
});

test("shouldReport fires on band transitions, not on every call", () => {
  expect(shouldReport(null, null)).toBe(false); // quiet stays quiet
  expect(shouldReport(null, 0)).toBe(true); // crossed into the first band
  expect(shouldReport(0, 0)).toBe(false); // same band -> don't repeat it
  expect(shouldReport(0, 1)).toBe(true); // got worse
  expect(shouldReport(1, 0)).toBe(true); // got better: also worth knowing
  // The top band repeats, because there the exact number drives the decision.
  const top = QUOTA_BANDS.length - 1;
  expect(shouldReport(top, top)).toBe(true);
});

test("formatQuotaClause says nothing at the utilizations actually observed", () => {
  // Both live snapshots are well below the first band: zero tokens spent.
  expect(formatQuotaClause("anthropic", parseQuotaHeaders(ANTHROPIC_200))).toBe("");
  expect(formatQuotaClause("openai", parseQuotaHeaders(CODEX_200))).toBe("");
});

test("formatQuotaClause reports the binding window, the others, and the reset", () => {
  const resetAt = 1_800_000_000;
  const now = (resetAt - 145 * 60) * 1000; // 2h 25m out
  const clause = formatQuotaClause(
    "anthropic",
    {
      windows: [
        { label: "5h", used: 0.82, resetAt },
        { label: "7d", used: 0.41 },
      ],
      binding: "5h",
    },
    { previousBand: null, now },
  );
  expect(clause).toContain("[QUOTA] anthropic: 5h 82% (binding), 7d 41% used.");
  expect(clause).toContain("resets in 2h 25m");
  // Band 1 of 3 is not an emergency -- no routing directive yet.
  expect(clause).not.toContain("Route further work");
});

test("formatQuotaClause escalates in the top band", () => {
  const clause = formatQuotaClause(
    "openai",
    {
      windows: [{ label: "5h", used: 0.97 }],
      binding: "5h",
      creditsExhausted: true,
      blocked: true,
    },
    { previousBand: 2 },
  );
  expect(clause).toContain("5h 97% (binding)");
  expect(clause).toContain("Credits are exhausted");
  expect(clause).toContain("REJECTING requests");
  expect(clause).toContain("Route further work to a different provider");
});

test("formatQuotaClause omits the reset when it cannot be computed", () => {
  const base = { windows: [{ label: "5h", used: 0.7 }], binding: "5h" };
  expect(formatQuotaClause("anthropic", base, { now: Date.now() })).not.toContain("resets in");
  // A reset already in the past is not rendered as a negative countdown.
  const past = { windows: [{ label: "5h", used: 0.7, resetAt: 1000 }], binding: "5h" };
  expect(formatQuotaClause("anthropic", past, { now: 9_000_000 })).not.toContain("resets in");
});

test("formatQuotaClause makes no claim without a snapshot", () => {
  for (const snapshot of [null, undefined, {}, { windows: [] }]) {
    expect(formatQuotaClause("anthropic", snapshot)).toBe("");
  }
});
