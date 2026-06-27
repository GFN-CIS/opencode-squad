import { test, expect } from "bun:test";
import { slugForModel, agentMarkdown, GENERATED_MARKER } from "../src/workers.js";

test("slug collapses provider/model and punctuation, prefixed by role", () => {
  expect(slugForModel("openai/gpt-5.5")).toBe("grunt-openai-gpt-5-5"); // default role
  expect(slugForModel("openai/gpt-5.5", "drill")).toBe("drill-openai-gpt-5-5");
  expect(slugForModel("anthropic/claude-opus-4-7", "grunt")).toBe(
    "grunt-anthropic-claude-opus-4-7",
  );
  expect(slugForModel("google/gemini-3.1-pro-preview-customtools")).toBe(
    "grunt-google-gemini-3-1-pro-preview-customtools",
  );
});

test("slug is stable and trimmed (no leading/trailing/doubled dashes)", () => {
  expect(slugForModel("  Foo//Bar..Baz  ", "drill")).toBe("drill-foo-bar-baz");
});

test("grunt markdown: edit/bash allowed, frontmatter, model, marker, body", () => {
  const body = "You are grunt, a worker subagent.";
  const { slug, filename, content } = agentMarkdown(
    "grunt",
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

test("drill markdown: read-only (edit/bash denied, webfetch allowed)", () => {
  const { slug, content } = agentMarkdown("drill", "openai/gpt-5.5", "REVIEW BODY");
  expect(slug).toBe("drill-openai-gpt-5-5");
  expect(content).toContain("edit: deny");
  expect(content).toContain("bash: deny");
  expect(content).toContain("webfetch: allow");
  expect(content).not.toContain("edit: allow");
  expect(content.trimEnd().endsWith("REVIEW BODY")).toBe(true);
});

test("unknown role throws", () => {
  expect(() => agentMarkdown("captain", "openai/gpt-5.5", "x")).toThrow();
});

test("frontmatter block is well-formed (opens and closes with ---)", () => {
  const { content } = agentMarkdown("grunt", "openai/gpt-5.5", "BODY");
  expect(content.indexOf("\n---\n", 4)).toBeGreaterThan(0);
});
