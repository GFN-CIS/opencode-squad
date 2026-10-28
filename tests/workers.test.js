import { expect, test } from "vitest";
import { PROMPT_CLOSE, promptOpen } from "../src/prompt-inject.js";
import { NOTES_CLOSE, NOTES_OPEN, parseAgentFile } from "../src/roster.js";
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

test("grunt markdown: native ordered edit/shell allows and explicit subagent deny", () => {
  const body = "You are grunt, a worker subagent.";
  const { slug, filename, content } = agentMarkdown("grunt", "anthropic/claude-opus-4-7");
  expect(slug).toBe("grunt-anthropic-claude-opus-4-7");
  expect(filename).toBe("grunt-anthropic-claude-opus-4-7.md");
  expect(content.startsWith("---\n")).toBe(true);
  expect(content).toContain("mode: subagent");
  expect(content).toContain("model: anthropic/claude-opus-4-7");
  expect(content).toContain("hidden: true");
  expect(content).toContain(
    'permissions:\n  - {"action":"edit","resource":"*","effect":"allow"}\n' +
      '  - {"action":"shell","resource":"*","effect":"allow"}\n' +
      '  - {"action":"subagent","resource":"*","effect":"deny"}\n---',
  );
  expect(content).not.toContain("permission:");
  expect(content).toContain(GENERATED_MARKER);
  expect(content).toContain(promptOpen("grunt"));
  expect(content.trimEnd().endsWith(PROMPT_CLOSE)).toBe(true);
  expect(content).not.toContain(body);
});

test("V2 drill markdown denies by default, allowing only local reads, web and narrow shell inspection", () => {
  const { slug, content } = agentMarkdown("drill", "openai/gpt-5.5");
  expect(slug).toBe("drill-openai-gpt-5-5");
  expect(content).toContain("permissions:\n");
  expect(content).not.toContain("permission:");
  const rules = content
    .split("permissions:\n")[1]
    .split("\n---")[0]
    .split("\n")
    .map((line) => JSON.parse(line.trim().slice(2)));
  expect(rules).toEqual([
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "read", resource: "*.env.*", effect: "ask" },
    { action: "read", resource: "*.env.example", effect: "allow" },
    ...["glob", "grep", "list", "skill", "webfetch", "websearch", "external_directory"].map(
      (action) => ({
        action,
        resource: "*",
        effect: "allow",
      }),
    ),
    { action: "shell", resource: "*", effect: "deny" },
    ...[
      "git log *",
      "git show *",
      "git diff *",
      "git blame *",
      "git status *",
      "git grep *",
      "git ls-files *",
      "git ls-tree *",
      "git cat-file *",
      "git rev-parse *",
      "git merge-base *",
      "git describe *",
      "git shortlog *",
      "gh pr view *",
      "gh pr diff *",
      "gh pr list *",
      "gh pr checks *",
      "gh issue view *",
      "gh issue list *",
      "gh run view *",
      "gh run list *",
      "gh repo view *",
      "gh release view *",
      "gh release list *",
      "glab mr view *",
      "glab mr diff *",
      "glab mr list *",
      "glab issue view *",
      "glab issue list *",
      "glab ci list *",
      "glab ci get *",
      "glab repo view *",
      "head *",
      "tail *",
      "wc *",
      "grep *",
      "sort *",
      "uniq *",
      "cut *",
    ].map((resource) => ({ action: "shell", resource, effect: "allow" })),
    { action: "shell", resource: "*--output*", effect: "deny" },
    { action: "shell", resource: "sort *-o*", effect: "deny" },
    { action: "shell", resource: "*>*", effect: "deny" },
  ]);
  // MCP (including future servers), Code Mode and mutation tools have no exception.
  for (const action of [
    "mcpproxy_call_tool_write",
    "jira_update",
    "execute",
    "subagent",
    "edit",
    "question",
  ]) {
    expect(rules.filter((rule) => rule.action === action)).toEqual([]);
  }
  expect(
    rules.filter((rule) => rule.effect === "allow").map((rule) => rule.resource),
  ).not.toContain("gh api *");
  expect(content).toContain(promptOpen("drill"));
  expect(content.trimEnd().endsWith(PROMPT_CLOSE)).toBe(true);
});

test("V2 write guards and env exceptions come after their broad allows", () => {
  const { content } = agentMarkdown("drill", "a/b");
  const rules = content
    .split("permissions:\n")[1]
    .split("\n---")[0]
    .split("\n")
    .map((line) => JSON.parse(line.trim().slice(2)));
  const index = (action, resource) =>
    rules.findIndex((r) => r.action === action && r.resource === resource);
  for (const resource of ["*--output*", "sort *-o*", "*>*"]) {
    expect(index("shell", resource)).toBeGreaterThan(index("shell", "sort *"));
    expect(index("shell", resource)).toBeGreaterThan(index("shell", "git diff *"));
  }
  expect(rules.at(-1)).toEqual({ action: "shell", resource: "*>*", effect: "deny" });
  expect(index("read", "*.env")).toBeGreaterThan(index("read", "*"));
  expect(index("read", "*.env.*")).toBeGreaterThan(index("read", "*.env"));
  expect(index("read", "*.env.example")).toBeGreaterThan(index("read", "*.env.*"));
});

test.each(["grunt", "drill"])(
  "native %s preserves overrides through a roster round trip",
  (role) => {
    const { content } = agentMarkdown(role, "openai/gpt-5.5", {
      variant: "high",
      disable: true,
      steps: 12,
      notes: "inspect edge cases",
    });
    expect(content).toContain("model: openai/gpt-5.5#high\n");
    expect(content).toContain("disabled: true\n");
    expect(content).not.toContain("\nvariant:");
    expect(content).not.toContain("\ndisable:");
    expect(parseAgentFile(content)).toEqual({
      modelId: "openai/gpt-5.5",
      entry: {
        description: defaultDescriptions()[role],
        variant: "high",
        disable: true,
        steps: 12,
        notes: "inspect edge cases",
      },
    });
  },
);

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
  expect(withVariant).toContain("model: zai-coding-plan/glm-5.3#high\n");

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
  expect(content).toContain("model: zai-coding-plan/glm-5.3#high\n");
  expect(content).toContain("steps: 40");
  expect(content).toContain("disabled: true");
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
