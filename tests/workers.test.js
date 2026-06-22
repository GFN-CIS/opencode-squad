import { test, expect } from "bun:test";
import { slugForModel, workerAgentMarkdown, GENERATED_MARKER } from "../src/workers.js";

test("slug collapses provider/model and punctuation to dashes", () => {
  expect(slugForModel("openai/gpt-5.5")).toBe("grunt-openai-gpt-5-5");
  expect(slugForModel("anthropic/claude-opus-4-7")).toBe(
    "grunt-anthropic-claude-opus-4-7",
  );
  expect(slugForModel("google/gemini-3.1-pro-preview-customtools")).toBe(
    "grunt-google-gemini-3-1-pro-preview-customtools",
  );
});

test("slug is stable and trimmed (no leading/trailing/doubled dashes)", () => {
  expect(slugForModel("  Foo//Bar..Baz  ")).toBe("grunt-foo-bar-baz");
});

test("generated markdown carries frontmatter, model, hidden, perms, marker, body", () => {
  const body = "You are grunt, a worker subagent.";
  const { slug, filename, content } = workerAgentMarkdown(
    "anthropic/claude-opus-4-7",
    body,
  );
  expect(slug).toBe("grunt-anthropic-claude-opus-4-7");
  expect(filename).toBe("grunt-anthropic-claude-opus-4-7.md");
  expect(content.startsWith("---\n")).toBe(true);
  expect(content).toContain("mode: subagent");
  expect(content).toContain("model: anthropic/claude-opus-4-7");
  expect(content).toContain("hidden: true");
  expect(content).toContain("edit: allow");
  expect(content).toContain("bash: allow");
  expect(content).toContain("'*': deny");
  expect(content).toContain(GENERATED_MARKER);
  expect(content.trimEnd().endsWith(body)).toBe(true);
});

test("frontmatter block is well-formed (opens and closes with ---)", () => {
  const { content } = workerAgentMarkdown("openai/gpt-5.5", "BODY");
  const fmEnd = content.indexOf("\n---\n", 4);
  expect(fmEnd).toBeGreaterThan(0); // a closing fence exists after the opening
});
