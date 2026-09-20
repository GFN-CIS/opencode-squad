import { expect, test } from "vitest";
import { PROMPT_CLOSE, promptOpen } from "../src/prompt-inject.js";
import { NOTES_CLOSE, NOTES_OPEN } from "../src/roster.js";
import {
  agentMarkdown,
  defaultDescriptions,
  GENERATED_MARKER,
  slugForModel,
} from "../src/workers.js";

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
  const { slug, filename, content } = agentMarkdown("grunt", "anthropic/claude-opus-4-7");
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
  expect(content).toContain(promptOpen("grunt"));
  expect(content.trimEnd().endsWith(PROMPT_CLOSE)).toBe(true);
  expect(content).not.toContain(body);
});

test("drill markdown: read-only (edit/bash denied, webfetch allowed)", () => {
  const { slug, content } = agentMarkdown("drill", "openai/gpt-5.5");
  expect(slug).toBe("drill-openai-gpt-5-5");
  expect(content).toContain("edit: deny");
  expect(content).toContain("bash: deny");
  expect(content).toContain("webfetch: allow");
  expect(content).not.toContain("edit: allow");
  expect(content).toContain(promptOpen("drill"));
  expect(content.trimEnd().endsWith(PROMPT_CLOSE)).toBe(true);
});

test("unknown role throws", () => {
  expect(() => agentMarkdown("captain", "openai/gpt-5.5")).toThrow();
});

test("frontmatter block is well-formed (opens and closes with ---)", () => {
  const { content } = agentMarkdown("grunt", "openai/gpt-5.5");
  expect(content.indexOf("\n---\n", 4)).toBeGreaterThan(0);
});

test("agentMarkdown emits variant only when one is given", () => {
  const withVariant = agentMarkdown("grunt", "zai-coding-plan/glm-5.3", {
    variant: "high",
  }).content;
  expect(withVariant).toContain("model: zai-coding-plan/glm-5.3\nvariant: high\n");

  const without = agentMarkdown("grunt", "anthropic/claude-opus-5").content;
  expect(without).not.toContain("variant:");
  expect(without).toContain("model: anthropic/claude-opus-5\nhidden: true\n");
});

test("agentMarkdown ignores a blank variant rather than writing an empty key", () => {
  const { content } = agentMarkdown("drill", "openai/gpt-5.5", { variant: "   " });
  expect(content).not.toContain("variant:");
});

test("the variant does not leak into the slug — one agent per model, not per variant", () => {
  const a = agentMarkdown("grunt", "zai-coding-plan/glm-5.3", { variant: "high" });
  const b = agentMarkdown("grunt", "zai-coding-plan/glm-5.3");
  expect(a.slug).toBe(b.slug);
  expect(a.filename).toBe(b.filename);
});

test("agentMarkdown writes the per-agent overrides, and only those that were given", () => {
  const { content } = agentMarkdown("grunt", "zai-coding-plan/glm-5.3", {
    variant: "high",
    description: "cheap long-context coder",
    notes: "prefer the write tool over bash heredocs",
    steps: 40,
    disable: true,
  });
  expect(content).toContain("description: cheap long-context coder");
  expect(content).toContain("variant: high");
  expect(content).toContain("steps: 40");
  expect(content).toContain("disable: true");
  expect(content).toContain(NOTES_OPEN);
  expect(content).toContain("prefer the write tool over bash heredocs");
  expect(content).toContain(NOTES_CLOSE);

  const bare = agentMarkdown("grunt", "a/b").content;
  expect(bare).not.toContain("variant:");
  expect(bare).not.toContain("steps:");
  expect(bare).not.toContain("disable:");
  expect(bare).not.toContain(NOTES_OPEN);
  // Falls back to the role's generic description rather than writing nothing.
  expect(bare).toContain(`description: ${defaultDescriptions().grunt}`);
});

test("notes are fenced so the body stays separable from the role prompt", () => {
  const { content } = agentMarkdown("drill", "a/b", { notes: "extra" });
  const body = content.slice(content.lastIndexOf("---\n") + 4);
  expect(body.indexOf(PROMPT_CLOSE)).toBeLessThan(body.indexOf(NOTES_OPEN));
  expect(body.indexOf(NOTES_OPEN)).toBeLessThan(body.indexOf(NOTES_CLOSE));
});

test("a blank override is ignored rather than written as an empty key", () => {
  const { content } = agentMarkdown("grunt", "a/b", { variant: "  ", notes: "  " });
  expect(content).not.toContain("variant:");
  expect(content).not.toContain(NOTES_OPEN);
});
