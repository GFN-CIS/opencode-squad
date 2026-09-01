import { expect, test } from "vitest";
import { agentMarkdown, GENERATED_MARKER, parseRosterEntry, slugForModel } from "../src/workers.js";

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
  const { slug, filename, content } = agentMarkdown("grunt", "anthropic/claude-opus-4-7", body);
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

test("parseRosterEntry splits a trailing @variant, and leaves plain ids alone", () => {
  expect(parseRosterEntry("zai-coding-plan/glm-5.3@high")).toEqual({
    modelId: "zai-coding-plan/glm-5.3",
    variant: "high",
  });
  expect(parseRosterEntry("  anthropic/claude-opus-5  ")).toEqual({
    modelId: "anthropic/claude-opus-5",
  });
  // Colons are part of real opencode model ids, so they must survive untouched.
  expect(parseRosterEntry("anthropic/claude-opus-4-thinking:32000")).toEqual({
    modelId: "anthropic/claude-opus-4-thinking:32000",
  });
  // A dangling separator is a typo, not a variant.
  expect(parseRosterEntry("openai/gpt-5.5@")).toEqual({ modelId: "openai/gpt-5.5" });
});

test("agentMarkdown emits variant only when one is given", () => {
  const withVariant = agentMarkdown("grunt", "zai-coding-plan/glm-5.3", "BODY", {
    variant: "high",
  }).content;
  expect(withVariant).toContain("model: zai-coding-plan/glm-5.3\nvariant: high\n");

  const without = agentMarkdown("grunt", "anthropic/claude-opus-5", "BODY").content;
  expect(without).not.toContain("variant:");
  expect(without).toContain("model: anthropic/claude-opus-5\nhidden: true\n");
});

test("agentMarkdown ignores a blank variant rather than writing an empty key", () => {
  const { content } = agentMarkdown("drill", "openai/gpt-5.5", "BODY", { variant: "   " });
  expect(content).not.toContain("variant:");
});

test("the variant does not leak into the slug — one agent per model, not per variant", () => {
  const a = agentMarkdown("grunt", "zai-coding-plan/glm-5.3", "B", { variant: "high" });
  const b = agentMarkdown("grunt", "zai-coding-plan/glm-5.3", "B");
  expect(a.slug).toBe(b.slug);
  expect(a.filename).toBe(b.filename);
});
