import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { checkSnapshot, SCHEMA_VERSION } from "../src/benchmarks-schema.js";

const bundled = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "benchmarks.json"),
    "utf8",
  ),
);

const entry = () => ({
  name: "GPT-5.5",
  creator: "openai",
  release_date: "2026-08-01",
  intelligence: 70.1,
  coding: 60,
  math: null,
  agentic: { tau2: 0.9, terminalbench_v2_1: null },
  benchmarks: { gpqa: 0.8, hle: null },
  price_blended: 10,
  price_input: 5,
  price_output: 30,
  tps: 100,
  ttft: 0.5,
});

const snap = (meta = {}, models = { "gpt-5-5": entry() }) => ({
  _meta: { schema: SCHEMA_VERSION, generated: "2026-09-29", ...meta },
  models,
});

test("the bundled snapshot passes its own schema", () => {
  expect(checkSnapshot(bundled).ok).toBe(true);
});

test("a well-formed snapshot passes", () => {
  const r = checkSnapshot(snap());
  expect(r.ok).toBe(true);
  expect(r.snapshot.models["gpt-5-5"].intelligence).toBe(70.1);
});

test("unknown extra fields are tolerated and kept", () => {
  const r = checkSnapshot(snap({ extra: 1 }, { m: { ...entry(), new_index: 5 } }));
  expect(r.ok).toBe(true);
  expect(r.snapshot.models.m.new_index).toBe(5);
});

test("a newer schema version is reported as schema-ahead, not as garbage", () => {
  const r = checkSnapshot(snap({ schema: SCHEMA_VERSION + 1 }, { m: { totally: "different" } }));
  expect(r).toEqual({ ok: false, reason: "schema-ahead", schema: SCHEMA_VERSION + 1 });
});

test("a missing schema version is invalid", () => {
  const s = snap();
  delete s._meta.schema;
  expect(checkSnapshot(s)).toMatchObject({ ok: false, reason: "invalid" });
});

test("a model without a numeric intelligence index is invalid", () => {
  expect(checkSnapshot(snap({}, { m: { ...entry(), intelligence: "70" } }))).toMatchObject({
    ok: false,
    reason: "invalid",
  });
});

test("a malformed generated date is invalid", () => {
  expect(checkSnapshot(snap({ generated: "yesterday" }))).toMatchObject({
    ok: false,
    reason: "invalid",
  });
});

test("an empty model set is invalid", () => {
  expect(checkSnapshot(snap({}, {}))).toMatchObject({ ok: false, reason: "invalid" });
});

test("non-objects are invalid", () => {
  for (const v of [null, 42, "x", []]) {
    expect(checkSnapshot(v)).toMatchObject({ ok: false, reason: "invalid" });
  }
});
