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
import {
  SQUAD_COMPACT_INPUT,
  SQUAD_DUMP_INPUT,
  SQUAD_PATCH_INPUT,
  SQUAD_SESSION_INPUT,
} from "../src/v2/schemas.js";
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
    expect(SQUAD_COMPACT_INPUT.required).toEqual(["sessionID"]);
    expect(Object.keys(SQUAD_COMPACT_INPUT.properties)).toEqual(["sessionID"]);
    expect(SQUAD_SESSION_INPUT.required).toBeUndefined();
    expect(SQUAD_SESSION_INPUT.properties.sessionIDs.type).toBe("array");
    expect(SQUAD_SESSION_INPUT.properties.sessionIDs.description).toBe(
      ARG_DESCRIPTIONS["session.sessionIDs"],
    );
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
    for (const s of [
      SQUAD_COMPACT_INPUT,
      SQUAD_DUMP_INPUT,
      SQUAD_PATCH_INPUT,
      SQUAD_SESSION_INPUT,
    ]) {
      expect(s.additionalProperties).toBe(false);
    }
    expect(Object.keys(TOOL_DESCRIPTIONS).sort()).toEqual([
      "squad_compact",
      "squad_dump",
      "squad_metrics",
      "squad_patch",
      "squad_session",
    ]);
  });
});

describe("V2 skills", () => {
  test("parseSkillFile handles quoted, single-quoted and block values", () => {
    expect(parseSkillFile('---\nname: a\ndescription: "say \\"hi\\""\n---\nBody').fields).toEqual({
      name: "a",
      description: 'say "hi"',
    });
    expect(parseSkillFile("---\nname: 'it''s'\n---\n").fields.name).toBe("it's");
    // YAML block scalars: `|` keeps lines and the final newline, `>-` folds.
    const block = parseSkillFile("---\nname: b\ndescription: |\n  one\n  two\n---\nBody");
    expect(block.fields.description).toBe("one\ntwo\n");
    expect(block.body).toBe("Body");
    expect(parseSkillFile("---\ndescription: >-\n  one\n  two\n---\n").fields.description).toBe(
      "one two",
    );
    expect(parseSkillFile("plain").body).toBe("plain");
  });

  test("parseSkillFile keeps a literal description past an empty line, LF or CRLF", () => {
    const lf = "---\nname: c\ndescription: |\n  first para\n\n  second para\n---\nBody\n";
    expect(parseSkillFile(lf).fields.description).toBe("first para\n\nsecond para\n");
    const crlf = lf.replaceAll("\n", "\r\n");
    const parsed = parseSkillFile(crlf);
    expect(parsed.fields.description).toBe("first para\n\nsecond para\n");
    expect(parsed.body).toBe("Body\r\n");
  });

  test("parseSkillFile: a header that is not YAML gives no fields, and the body after it", () => {
    expect(parseSkillFile("---\nname: [unclosed\n---\nBody")).toEqual({ fields: {}, body: "Body" });
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
    try {
      expect(loadSkills([path.join(dir, "missing"), dir])).toEqual([
        {
          id: "bare",
          name: "bare",
          path: path.join(dir, "bare", "SKILL.md"),
          content: "no frontmatter",
        },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
