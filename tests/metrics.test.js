// Suite: src/metrics.js — matching opencode ids to SuperIndex/llmbenchmark
// entries and rendering the squad_metrics text. Fixtures are trimmed real
// responses (2026-11-12) under tests/fixtures/metrics; no network.
// Run: npx vitest run tests/metrics.test.js

import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  connectedModels,
  formatDetail,
  formatSummary,
  indexModelIds,
  indexScoreRows,
  indexSuperIndex,
  isSubscription,
  KEY_METRICS,
  keyCandidates,
  lookup,
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
  test("coding/token plans are subscriptions; model_data billing overrides", () => {
    expect(isSubscription("zai-coding-plan/glm-5.3")).toBe(true);
    expect(isSubscription("alibaba-token-plan/qwen")).toBe(true);
    expect(isSubscription("anthropic/claude-opus-5-5")).toBe(false);
    expect(isSubscription("anthropic/claude-opus-5-5", { billing: "subscription" })).toBe(true);
    expect(isSubscription("zai-coding-plan/glm-5.3", { billing: "api" })).toBe(false);
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
    data: DATA,
    now,
  });
  const line = (id) => out.split("\n").find((l) => l.startsWith(`- ${id}`)) ?? "";

  test("header states sources, age, attribution and the effort caveat", () => {
    expect(out).toContain("CC-BY-4.0");
    expect(out).toContain("fetched 5h ago");
    expect(out).toContain("NOT at your agents' variant");
  });

  test("subscription replaces the list price; roles and notes are shown", () => {
    expect(line("zai-coding-plan/glm-5.3")).toContain("[grunt+drill]");
    expect(line("zai-coding-plan/glm-5.3")).toContain("billing: subscription");
    expect(line("zai-coding-plan/glm-5.3")).not.toContain("$1.4");
    expect(line("anthropic/claude-sonnet-5-5")).toContain("$2/$10");
    expect(line("anthropic/claude-sonnet-5-5")).toContain("note: careful reviewer");
  });

  test("a missing benchmark is left out, never printed as zero", () => {
    // livebench_coding has no glm-5.3 row in the fixture.
    expect(line("zai-coding-plan/glm-5.3")).not.toContain("LiveBench-coding");
    expect(line("zai-coding-plan/glm-5.3")).toContain("TerminalBench4 0.418");
  });

  test("models with no data collapse into one trailing line", () => {
    expect(out).toContain("- no benchmark data: opencode/big-pickle, opencode/iceman-free");
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

  test("a serving tier of a listed model collapses to one line", () => {
    const text = formatSummary({
      models: [{ id: "openai/gpt-6.1-terra" }, { id: "openai/gpt-6.1-terra-fast" }],
      roles: { "openai/gpt-6.1-terra-fast": ["grunt"] },
      data: DATA,
      now,
    });
    expect(text).toContain(
      "- openai/gpt-6.1-terra-fast [grunt]: same data as openai/gpt-6.1-terra",
    );
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

describe("host helpers", () => {
  test("connectedModels flattens providers with context", () => {
    expect(
      connectedModels([{ id: "p", models: { a: { limit: { context: 1000 } }, b: {} } }]),
    ).toEqual([{ id: "p/a", context: 1000 }, { id: "p/b" }]);
  });

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
