// Suite: src/metrics.js — matching opencode ids to SuperIndex/llmbenchmark
// entries and rendering the squad_metrics text. Fixtures are trimmed real
// responses (2026-11-12) under tests/fixtures/metrics; no network.
// Run: npx vitest run tests/metrics.test.js

import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  billingFor,
  formatDetail,
  formatSummary,
  indexModelIds,
  indexScoreRows,
  indexSuperIndex,
  KEY_METRICS,
  keyCandidates,
  lookup,
  ownerRules,
  providerEntry,
  squadRoles,
} from "../src/metrics.js";

const fixture = (name) =>
  JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "metrics", name), "utf8"));

const SI = indexSuperIndex(fixture("superindex.json"));
const ROWS = fixture("llmbench-scores.json");
const BY_METRIC = Object.fromEntries(
  Object.entries(ROWS).map(([metric, rows]) => [metric, indexScoreRows(rows)]),
);
const DATA = {
  superindex: { fetchedAt: 0, index: SI },
  scores: { fetchedAt: 0, byMetric: BY_METRIC },
};

// The squad as opencode names it; each source spells these differently.
const SQUAD = [
  "anthropic/claude-fable-5-1",
  "anthropic/claude-haiku-5-5",
  "anthropic/claude-opus-5-5",
  "anthropic/claude-sonnet-5-5",
  "openai/gpt-6-astra",
  "openai/gpt-6-luna",
  "openai/gpt-6.1-sol",
  "openai/gpt-6.1-terra",
  "zai-coding-plan/glm-5.3",
  "zai-coding-plan/glm-5.3-flash",
];

describe("matching", () => {
  test("every squad model resolves in SuperIndex despite different provider ids", () => {
    for (const id of SQUAD) expect(lookup(id, SI), id).not.toBeNull();
    expect(lookup("zai-coding-plan/glm-5.3", SI)?.entry.id).toBe("zhipuai/glm-5.3");
  });

  test("every squad model resolves in llmbenchmark terminal-bench rows", () => {
    const tb = BY_METRIC.tbench_4_0_accuracy;
    for (const id of SQUAD) expect(lookup(id, tb), id).not.toBeNull();
    expect(lookup("anthropic/claude-sonnet-5-5", tb)?.entry.id).toBe("anthropic/claude-sonnet-5.5");
  });

  test("glm-5.3 never picks up a -flash / -flashx sibling", () => {
    expect(lookup("zai-coding-plan/glm-5.3", SI)?.entry.id).toBe("zhipuai/glm-5.3");
    expect(lookup("zai-coding-plan/glm-5.3-flash", SI)?.entry.id).toBe("zhipuai/glm-5.3-flash");
    expect(keyCandidates("zai-coding-plan/glm-5.3")).toEqual(["glm-5-3"]);
  });

  test("serving-tier suffixes fall back to the same weights, exact id first", () => {
    expect(keyCandidates("openai/gpt-6.1-terra-fast")).toEqual([
      "gpt-6-1-terra-fast",
      "gpt-6-1-terra",
    ]);
    expect(lookup("zai-coding-plan/glm-5.3-highspeed", SI)?.key).toBe("glm-5-3");
    expect(lookup("opencode/glm-5.3-flash-free", SI)?.key).toBe("glm-5-3-flash");
    expect(lookup("openai/gpt-6.1-terra-fast", SI)?.key).toBe("gpt-6-1-terra");
  });

  test("unknown model -> null", () => {
    expect(lookup("opencode/big-pickle", SI)).toBeNull();
  });

  test("indexModelIds keys llmbenchmark ids by normalized model part", () => {
    expect(indexModelIds([{ id: "z-ai/glm-5.3" }, { id: "x" }])).toEqual({
      "glm-5-3": "z-ai/glm-5.3",
      x: "x",
    });
  });
});

describe("indexScoreRows", () => {
  test("keeps every setting for one model instead of collapsing to the best", () => {
    const idx = indexScoreRows([
      { modelId: "a/m", value: 0.4, setting: "high" },
      { modelId: "a/m", value: 0.6, setting: "max" },
      { modelId: "a/m", value: null },
    ]);
    expect(idx.m.values).toEqual([
      { value: 0.4, setting: "high" },
      { value: 0.6, setting: "max" },
    ]);
  });
});

describe("billing", () => {
  test("provider plan names the subscription; api means metered", () => {
    const plans = { anthropic: "Max 5x", openai: "api" };
    expect(billingFor("anthropic/claude-opus-5-5", { plans })).toEqual({
      api: false,
      plan: "Max 5x",
    });
    expect(billingFor("openai/gpt-6-luna", { plans, authTypes: { openai: "oauth" } })).toEqual({
      api: true,
    });
  });

  test("without a plan: oauth login or a *-plan provider is a subscription", () => {
    expect(billingFor("openai/gpt-6-luna", { authTypes: { openai: "oauth" } })).toEqual({
      api: false,
      plan: null,
    });
    expect(billingFor("zai-coding-plan/glm-5.3")).toEqual({ api: false, plan: null });
    expect(billingFor("alibaba-token-plan/qwen")).toEqual({ api: false, plan: null });
    expect(billingFor("google/gemini", { authTypes: { google: "api" } })).toEqual({ api: true });
  });

  test("a model's own billing overrides its provider", () => {
    const plans = { "zai-coding-plan": "GLM Coding Pro" };
    expect(billingFor("zai-coding-plan/glm-5.3", { plans, note: { billing: "api" } })).toEqual({
      api: true,
    });
    expect(billingFor("anthropic/x", { note: { billing: "subscription" } })).toEqual({
      api: false,
      plan: null,
    });
  });
});

describe("owner rules", () => {
  test("a provider entry is a plan string or {plan, info}", () => {
    expect(providerEntry("Max 5x")).toEqual({ plan: "Max 5x", info: null });
    expect(providerEntry({ plan: " GLM  Pro ", info: "no secrets" })).toEqual({
      plan: "GLM Pro",
      info: "no secrets",
    });
    expect(providerEntry({ info: "x" })).toEqual({ plan: null, info: "x" });
    expect(providerEntry(null)).toEqual({ plan: null, info: null });
  });

  test("provider rule first, then the model's own; billing reads the object's plan", () => {
    const providers = { z: { plan: "GLM Pro", info: "no secrets" } };
    expect(ownerRules("z/glm", { providers, note: { info: "short tasks" } })).toEqual([
      "no secrets",
      "short tasks",
    ]);
    expect(ownerRules("a/b", { providers, note: { info: " " } })).toEqual([]);
    expect(billingFor("z/glm", { plans: providers })).toEqual({ api: false, plan: "GLM Pro" });
  });
});

describe("formatSummary", () => {
  const now = 5 * 3600_000;
  const out = formatSummary({
    models: [
      { id: "zai-coding-plan/glm-5.3", context: 1_000_000 },
      { id: "anthropic/claude-sonnet-5-5" },
      { id: "opencode/big-pickle" },
      { id: "opencode/iceman-free" },
    ],
    roles: { "zai-coding-plan/glm-5.3": ["grunt", "drill"] },
    notes: { "anthropic/claude-sonnet-5-5": { info: "careful reviewer" } },
    plans: { "zai-coding-plan": "GLM Coding Pro" },
    data: DATA,
    now,
  });
  const line = (id) => out.split("\n").find((l) => l.startsWith(`- ${id}`)) ?? "";

  test("header shows the age of each benchmark when they differ", () => {
    const hour = 3600_000;
    const mixed = formatSummary({
      models: [{ id: "anthropic/claude-sonnet-5-5" }],
      data: {
        superindex: DATA.superindex,
        scores: {
          byMetric: BY_METRIC,
          fetchedAtByMetric: Object.fromEntries(
            KEY_METRICS.map(({ metric }) => [
              metric,
              metric === "tbench_4_0_accuracy" ? 0 : 50 * hour,
            ]),
          ),
        },
      },
      now: 52 * hour,
    });
    expect(mixed).toContain("llmbenchmark.ai: fetched 2h ago (TerminalBench4: 52h ago).");
  });

  test("header states sources, age, attribution and the effort caveat", () => {
    expect(out).toContain("CC-BY-4.0");
    expect(out).toContain("fetched 5h ago");
    expect(out).toContain("NOT at your agents' variant");
  });

  test("subscription replaces the list price; roles and notes are shown", () => {
    expect(line("zai-coding-plan/glm-5.3")).toContain("[grunt+drill]");
    expect(line("zai-coding-plan/glm-5.3")).toContain("subscription: GLM Coding Pro");
    expect(line("zai-coding-plan/glm-5.3")).not.toContain("$1.4");
    expect(line("anthropic/claude-sonnet-5-5")).toContain("$2/$10");
    expect(line("anthropic/claude-sonnet-5-5")).toContain("owner rule: careful reviewer");
  });

  test("a missing benchmark is left out, never printed as zero", () => {
    // livebench_coding has no glm-5.3 row in the fixture.
    expect(line("zai-coding-plan/glm-5.3")).not.toContain("LiveBench-coding");
    expect(line("zai-coding-plan/glm-5.3")).toContain("TerminalBench4 0.418");
  });

  test("only models with nothing to show collapse into one trailing line", () => {
    expect(out).toContain("- no benchmark data: opencode/big-pickle");
    expect(out).not.toContain("- no benchmark data: opencode/big-pickle,");
    // Free is how it is paid for: that stays visible.
    expect(line("opencode/iceman-free")).toBe("- opencode/iceman-free: free · no benchmark data");
  });

  test("a model without benchmarks keeps its context, plan and rules (#34)", () => {
    const text = formatSummary({
      models: [{ id: "zai-coding-plan/glm-9-unlisted", context: 200_000 }],
      roles: { "zai-coding-plan/glm-9-unlisted": ["grunt"] },
      notes: { "zai-coding-plan/glm-9-unlisted": { info: "short tasks" } },
      plans: { "zai-coding-plan": "GLM Coding Pro" },
      data: DATA,
      now,
    });
    expect(text).toContain(
      "- zai-coding-plan/glm-9-unlisted [grunt]: ctx 200k · subscription: GLM Coding Pro · " +
        "no benchmark data · owner rule: short tasks",
    );
    expect(text).not.toContain("- no benchmark data:");
  });

  test("no data at all says so instead of rendering an empty table", () => {
    const empty = formatSummary({ models: [{ id: "a/b" }], data: null, now });
    expect(empty).toContain("Metrics are unavailable right now");
  });

  test("labels cover every key metric", () => {
    for (const { label } of KEY_METRICS) expect(out).toContain(label);
  });

  test("an unranked SuperIndex score is marked provisional, not shown as ranked", () => {
    // gpt-6.1-terra has a score but no rank in the fixture.
    const text = formatSummary({ models: [{ id: "openai/gpt-6.1-terra" }], data: DATA, now });
    expect(text).toMatch(/SI 69\.8 \(provisional, conf \d+%\)/);
  });

  test("a -free tier says free instead of the paid base model's price", () => {
    const text = formatSummary({
      models: [{ id: "opencode/glm-5.3-flash-free" }],
      data: DATA,
      now,
    });
    expect(text).toContain("· free ·");
    expect(text).not.toContain("$0.15");
  });

  test("a serving tier shares benchmarks only, not the other model's price", () => {
    const text = formatSummary({
      models: [{ id: "openai/gpt-6.1-terra" }, { id: "openai/gpt-6.1-terra-fast" }],
      roles: { "openai/gpt-6.1-terra-fast": ["grunt"] },
      data: DATA,
      now,
    });
    expect(text).toContain(
      "- openai/gpt-6.1-terra-fast [grunt]: tier ctx unknown · tier price unknown · " +
        "same benchmarks as openai/gpt-6.1-terra",
    );
  });

  describe("a tier never shows its base model's price (#34)", () => {
    // Only the base model x/b has a priced row.
    const PRICED = {
      superindex: {
        fetchedAt: 0,
        index: indexSuperIndex({
          models: [
            { id: "x/b", si_score: 70, rank: 5, price_in: 5, price_out: 20 },
            { id: "x/c", si_score: 60, rank: 9, price_in: 1, price_out: 4 },
            { id: "x/c-fast", si_score: 60, rank: 9, price_in: 3, price_out: 12 },
          ],
        }),
      },
    };
    const summary = (ids) =>
      formatSummary({ models: ids.map((id) => ({ id })), data: PRICED, now }).split("\n");
    const lineOf = (lines, id) => lines.find((l) => l.startsWith(`- ${id}:`)) ?? "";

    test("asked alone, the tier shows the shared row but not its price", () => {
      const fast = lineOf(summary(["x/b-fast"]), "x/b-fast");
      expect(fast).toContain("SI 70 #5");
      expect(fast).toContain("(data for b)");
      expect(fast).not.toContain("$5/$20");
      expect(fast).toContain("tier price unknown");
    });

    test("asked with the base model, the base keeps its price and the tier does not", () => {
      const lines = summary(["x/b", "x/b-fast"]);
      expect(lineOf(lines, "x/b")).toContain("$5/$20");
      expect(lineOf(lines, "x/b-fast")).toBe(
        "- x/b-fast: tier ctx unknown · tier price unknown · same benchmarks as x/b",
      );
    });

    test("a tier with its own priced row shows its own price", () => {
      expect(lineOf(summary(["x/c-fast"]), "x/c-fast")).toContain("$3/$12");
      expect(lineOf(summary(["x/c", "x/c-fast"]), "x/c-fast")).toContain("$3/$12");
    });

    test("a dated or -latest alias of the same model keeps the price", () => {
      expect(lineOf(summary(["x/b-20260101"]), "x/b-20260101")).toContain("$5/$20");
      const lines = summary(["x/b", "x/b-latest"]);
      expect(lineOf(lines, "x/b-latest")).toBe("- x/b-latest: $5/$20 · same benchmarks as x/b");
    });

    test("the full detail names the base row and keeps its price off the tier", () => {
      const row = lookup("x/b-fast", PRICED.superindex.index)?.entry ?? null;
      const text = formatDetail("x/b-fast", null, row);
      expect(text).toContain("SuperIndex (row of x/b): 70 (#5)");
      expect(text).toContain("tier price unknown");
      expect(text).not.toContain("$5/$20");
      const own = formatDetail("x/b", null, lookup("x/b", PRICED.superindex.index)?.entry ?? null);
      expect(own).toContain("SuperIndex: 70 (#5)");
      expect(own).toContain("$5/$20 per 1M");
    });
  });

  test("a free tier with shared scores stays free, with its own context limit (#34)", () => {
    const text = formatSummary({
      models: [
        { id: "openai/gpt-6.1-terra", context: 1_000_000 },
        { id: "openai/gpt-6.1-terra-free", context: 128_000 },
      ],
      data: DATA,
      now,
    });
    expect(text).toContain(
      "- openai/gpt-6.1-terra-free: ctx 128k · free · same benchmarks as openai/gpt-6.1-terra",
    );
    expect(text).toContain("- openai/gpt-6.1-terra: SI 69.8");
  });
});

describe("formatDetail", () => {
  test("lists every score grouped by source with its setting", () => {
    const text = formatDetail(
      "zai-coding-plan/glm-5.3",
      fixture("llmbench-detail-glm-5.3.json"),
      lookup("zai-coding-plan/glm-5.3", SI)?.entry ?? null,
    );
    expect(text).toContain("## zai-coding-plan/glm-5.3");
    expect(text).toContain("SuperIndex: 80.6 (#19)");
    expect(text).toContain("cursorbench (max): cursorbench_4_0_score=0.426");
    expect(text).toMatch(/lmarena \(Max\): webdev_elo=1622 elo/);
    expect(text).not.toContain("_votes");
  });

  test("Artificial Analysis rows relayed by llmbenchmark are dropped", () => {
    const text = formatDetail(
      "a/b",
      {
        id: "a/b",
        scores: [
          { metric: "aa_intelligence_index", source: "aa-api", value: 31.7, unit: "points" },
          { metric: "tbench_4_0_accuracy", source: "terminal-bench", value: 0.4 },
        ],
      },
      null,
    );
    expect(text).not.toContain("aa_intelligence_index");
    expect(text).toContain("terminal-bench: tbench_4_0_accuracy=0.4");
  });

  test("unavailable detail is said, not hidden", () => {
    expect(formatDetail("a/b", null, null)).toContain("not found or unavailable");
  });
});

describe("exact provider/model match wins over a shared basename (#54)", () => {
  const ONE = {
    id: "vendor-one/m",
    si_score: 70,
    rank: 5,
    price_in: 3,
    price_out: 15,
    context_window: 200_000,
  };
  const TWO = {
    id: "vendor-two/m",
    si_score: 71,
    rank: 4,
    price_in: 9,
    price_out: 30,
    context_window: 400_000,
  };
  const orders = [
    ["vendor-one first", indexSuperIndex({ models: [ONE, TWO] })],
    ["vendor-two first", indexSuperIndex({ models: [TWO, ONE] })],
  ];
  const now = 0;
  const summaryLine = (index, id) =>
    formatSummary({ models: [{ id }], data: { superindex: { fetchedAt: 0, index } }, now })
      .split("\n")
      .find((l) => l.startsWith(`- ${id}:`)) ?? "";

  for (const [name, index] of orders) {
    test(`the exact row supplies its own price and context (${name})`, () => {
      expect(lookup("vendor-two/m", index)?.entry.id).toBe("vendor-two/m");
      expect(lookup("vendor-one/m", index)?.entry.id).toBe("vendor-one/m");
      const line = summaryLine(index, "vendor-two/m");
      expect(line).toContain("$9/$30");
      expect(line).toContain("ctx 400k");
      expect(line).not.toContain("$3/$15");
      expect(line).not.toContain("(data for");
      const full = formatDetail("vendor-two/m", null, lookup("vendor-two/m", index)?.entry ?? null);
      expect(full).toContain("$9/$30 per 1M");
      expect(full).toContain("ctx 400k");
    });

    test(`a third provider gets neither provider's price or context (${name})`, () => {
      const line = summaryLine(index, "vendor-three/m");
      expect(line).not.toMatch(/\$\d/);
      expect(line).not.toContain("ctx 200k");
      expect(line).not.toContain("ctx 400k");
      const full = formatDetail(
        "vendor-three/m",
        null,
        lookup("vendor-three/m", index)?.entry ?? null,
      );
      expect(full).not.toMatch(/\$\d/);
    });
  }

  test("a third provider's result does not depend on row order", () => {
    const [a, b] = orders.map(([, index]) => summaryLine(index, "vendor-three/m"));
    expect(a).toBe(b);
  });

  test("a unique basename still matches across provider names", () => {
    expect(summaryLine(indexSuperIndex({ models: [ONE] }), "router/m")).toContain("$3/$15");
  });
});

describe("a tier's context and billing come from the tier, in both views (#53)", () => {
  const index = indexSuperIndex({
    models: [
      { id: "p/model", si_score: 70, rank: 5, price_in: 1, price_out: 5, context_window: 200_000 },
      {
        id: "p/model-free",
        si_score: 70,
        rank: 5,
        price_in: 3,
        price_out: 10,
        context_window: 200_000,
      },
    ],
  });
  const data = { superindex: { fetchedAt: 0, index } };
  const summaryLine = (id, context) =>
    formatSummary({ models: [{ id, ...(context ? { context } : {}) }], data, now: 0 })
      .split("\n")
      .find((l) => l.startsWith(`- ${id}:`)) ?? "";
  const full = (id, context) =>
    formatDetail(id, null, lookup(id, index)?.entry ?? null, { context });

  test("a tier with no context of its own says its limit is unknown", () => {
    const line = summaryLine("p/model-fast");
    expect(line).not.toContain("200k");
    expect(line).toContain("tier ctx unknown");
    const text = full("p/model-fast");
    expect(text).not.toContain("200k");
    expect(text).toContain("tier ctx unknown");
  });

  test("the catalog's context for the tier is used in both views", () => {
    expect(summaryLine("p/model-fast", 128_000)).toContain("ctx 128k");
    expect(full("p/model-fast", 128_000)).toContain("ctx 128k");
  });

  test("a -free tier is free in both views, even with a priced row of its own", () => {
    expect(summaryLine("p/model-free")).toContain("free");
    expect(summaryLine("p/model-free")).not.toContain("$3/$10");
    const text = full("p/model-free");
    expect(text).toContain("free");
    expect(text).not.toContain("$3/$10");
  });
});

describe("host helpers", () => {
  test("squadRoles maps models to grunt/drill and ignores other agents", () => {
    expect(
      squadRoles([
        { name: "grunt-x", model: { providerID: "p", modelID: "m" } },
        { name: "drill-x", model: { providerID: "p", modelID: "m" } },
        { name: "explore", model: { providerID: "p", modelID: "m" } },
      ]),
    ).toEqual({ "p/m": ["grunt", "drill"] });
  });
});
