import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  ARG_DESCRIPTIONS,
  formatVariantLines,
  isSubagentCaller,
  TOOL_DESCRIPTIONS,
  validateVariants,
} from "../src/squad-tools.js";
import { subagentUsage, taskNotes } from "../src/task-notes.js";
import { SQUAD_COMPACT_INPUT, SQUAD_DUMP_INPUT, SQUAD_PATCH_INPUT } from "../src/v2/schemas.js";
import { loadSkills, parseSkillFile } from "../src/v2/skills.js";

describe("squad-tools", () => {
  test("isSubagentCaller matches grunts and drills only", () => {
    expect(isSubagentCaller("grunt-glm")).toBe(true);
    expect(isSubagentCaller("drill-opus")).toBe(true);
    expect(isSubagentCaller("build")).toBe(false);
    expect(isSubagentCaller(undefined)).toBe(false);
  });

  test("formatVariantLines: unknown lookup, empty roster, per-model lines", () => {
    const roster = { grunts: { "zai/glm": {} }, drills: { "a/opus": {}, "x/missing": {} } };
    expect(formatVariantLines(null, roster)).toContain("could not be read");
    expect(formatVariantLines({}, { grunts: {}, drills: {} })).toBe("");
    const out = formatVariantLines({ "zai/glm": ["low", "max"], "a/opus": [] }, roster);
    expect(out).toContain("  a/opus: (none — leave variant unset)");
    expect(out).toContain("  x/missing: unknown (model not in this install)");
    expect(out).toContain("  zai/glm: low | max");
    expect(out.indexOf("a/opus")).toBeLessThan(out.indexOf("zai/glm"));
  });

  test("validateVariants flags only variants opencode rejects", () => {
    const roster = {
      grunts: { "zai/glm": { variant: "medium" }, "x/unknown": { variant: "high" } },
      drills: { "a/opus": { variant: "high" }, "a/none": { variant: "low" } },
    };
    const map = { "zai/glm": ["low", "max"], "a/opus": ["high"], "a/none": [] };
    const errors = validateVariants(roster, map);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('grunts["zai/glm"].variant "medium"');
    expect(errors[1]).toContain("(none: leave it unset)");
    expect(validateVariants(roster, null)).toEqual([]);
  });
});

describe("V2 schemas", () => {
  test("declare tool arguments and carry the shared wording", () => {
    expect(SQUAD_COMPACT_INPUT.required).toEqual(["task_id"]);
    expect(Object.keys(SQUAD_PATCH_INPUT.properties).sort()).toEqual([
      "allow_remove",
      "directory",
      "drills",
      "grunts",
    ]);
    expect(SQUAD_PATCH_INPUT.properties.grunts.additionalProperties.properties.steps.type).toBe(
      "integer",
    );
    expect(SQUAD_DUMP_INPUT.properties.directory.description).toBe(
      ARG_DESCRIPTIONS["dump.directory"],
    );
    for (const s of [SQUAD_COMPACT_INPUT, SQUAD_DUMP_INPUT, SQUAD_PATCH_INPUT]) {
      expect(s.additionalProperties).toBe(false);
    }
    expect(Object.keys(TOOL_DESCRIPTIONS).sort()).toEqual([
      "squad_compact",
      "squad_dump",
      "squad_patch",
    ]);
  });
});

describe("task notes", () => {
  const msgs = [
    { info: { role: "user", time: { created: 1 } } },
    {
      info: {
        role: "assistant",
        time: { created: 100 },
        finish: "length",
        tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 0, write: 0 } },
        modelID: "m",
        providerID: "p",
      },
    },
    { info: { role: "assistant", time: { created: 200 } } },
  ];

  test("subagentUsage separates newest contact from newest finished turn", () => {
    expect(subagentUsage(msgs)).toEqual({
      lastHitMs: 200,
      contextTokens: 35,
      finish: "length",
      outputTokens: 20,
      reasoningTokens: 5,
    });
    expect(subagentUsage([])).toEqual({
      lastHitMs: null,
      contextTokens: undefined,
      finish: undefined,
      outputTokens: undefined,
      reasoningTokens: undefined,
    });
  });

  test("taskNotes: outcome first, cache status only with model and timestamp", () => {
    const usage = subagentUsage(msgs);
    const base = {
      taskId: "t1",
      usage,
      resultEmpty: false,
      modelData: { "p/m": { cache_ttl_seconds: 300 } },
      limitMap: { "p/m": 1000 },
      now: 250,
      timeZone: "UTC",
    };
    const both = taskNotes({ ...base, providerID: "p", modelID: "m" });
    expect(both).toHaveLength(2);
    expect(both[0]).toContain("[TASK OUTCOME] task_id=t1");
    expect(both[1]).toContain("[CACHE STATUS]");
    expect(taskNotes({ ...base })).toHaveLength(1);
    const clean = taskNotes({
      ...base,
      usage: { ...usage, finish: "stop", lastHitMs: null },
      providerID: "p",
      modelID: "m",
    });
    expect(clean).toEqual([]);
    const providerTtl = taskNotes({
      ...base,
      modelData: null,
      providerID: "anthropic",
      modelID: "m",
    });
    expect(providerTtl.at(-1)).toContain("[CACHE STATUS]");
  });
});

describe("V2 skills", () => {
  test("parseSkillFile handles quoted, single-quoted and block values", () => {
    expect(parseSkillFile('---\nname: a\ndescription: "say \\"hi\\""\n---\nBody').fields).toEqual({
      name: "a",
      description: 'say "hi"',
    });
    expect(parseSkillFile("---\nname: 'it''s'\n---\n").fields.name).toBe("it's");
    const block = parseSkillFile("---\nname: b\ndescription: |\n  one\n  two\n---\nBody");
    expect(block.fields.description).toBe("one\ntwo");
    expect(block.body).toBe("Body");
    expect(parseSkillFile("plain").body).toBe("plain");
  });

  test("loadSkills reads the bundled skills and skips what it cannot read", () => {
    const skills = loadSkills([path.resolve(import.meta.dirname, "..", "skills")]);
    expect(skills.map((s) => s.id).sort()).toEqual([
      "squad-delegate",
      "squad-draft",
      "squad-redteam",
      "squad-stall",
    ]);
    for (const s of skills) {
      expect(path.isAbsolute(s.path)).toBe(true);
      expect(s.content.startsWith("---")).toBe(false);
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squad-skills-"));
    fs.mkdirSync(path.join(dir, "bare"));
    fs.writeFileSync(path.join(dir, "bare", "SKILL.md"), "no frontmatter");
    fs.mkdirSync(path.join(dir, "empty"));
    fs.writeFileSync(path.join(dir, "file.txt"), "x");
    expect(loadSkills([path.join(dir, "missing"), dir])).toEqual([
      {
        id: "bare",
        name: "bare",
        path: path.join(dir, "bare", "SKILL.md"),
        content: "no frontmatter",
      },
    ]);
  });
});
