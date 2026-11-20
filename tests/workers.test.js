// Suite: src/workers.js — agent ids, role permission rules and descriptions.
// Run: npx vitest run tests/workers.test.js

import { expect, test } from "vitest";
import {
  defaultDescriptions,
  describeAgent,
  isGeneratedAgent,
  roleRules,
  slugForModel,
  squadRoleOf,
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

test("grunt rules: edit and shell allowed, subagent denied", () => {
  expect(roleRules("grunt")).toEqual([
    { action: "edit", resource: "*", effect: "allow" },
    { action: "shell", resource: "*", effect: "allow" },
    { action: "subagent", resource: "*", effect: "deny" },
  ]);
});

test("drill rules deny by default, allowing only local reads, web and narrow shell inspection", () => {
  const rules = roleRules("drill");
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
});

test("drill write guards and env exceptions come after their broad allows", () => {
  const rules = roleRules("drill");
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

test("unknown role throws", () => {
  expect(() => roleRules("captain")).toThrow();
});

test("roleRules hands out copies: a caller cannot edit the role's policy", () => {
  roleRules("drill")[0].effect = "allow";
  expect(roleRules("drill")[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
});

test("describeAgent carries the owner rule and the plan, nothing invented", () => {
  const base = defaultDescriptions().grunt;
  expect(describeAgent("grunt")).toBe(base);
  expect(
    describeAgent("grunt", {
      rules: ["  no secrets:\n prod is off-limits ", "short tasks"],
      billing: { api: false, plan: "GLM Coding Pro" },
    }),
  ).toBe(
    `${base} Owner rule: no secrets: prod is off-limits. Owner rule: short tasks. Billing: subscription (GLM Coding Pro).`,
  );
  expect(describeAgent("drill", { rules: [""], billing: { api: true } })).toBe(
    `${defaultDescriptions().drill} Billing: metered API.`,
  );
  expect(describeAgent("grunt", { billing: { api: false, plan: null } })).toBe(
    `${base} Billing: subscription.`,
  );
  expect(() => describeAgent("captain")).toThrow();
});

test("squadRoleOf reads the role off a runtime agent id and nothing else", () => {
  expect(squadRoleOf("grunt-openai-gpt-5-5")).toBe("grunt");
  expect(squadRoleOf("drill-anthropic-claude-opus-5")).toBe("drill");
  // Legacy worker- files are migrated on disk; at runtime they are not squad.
  expect(squadRoleOf("worker-openai-gpt-5-5")).toBeNull();
  expect(squadRoleOf("build")).toBeNull();
  expect(squadRoleOf("my-grunt-helper")).toBeNull();
  expect(squadRoleOf(undefined)).toBeNull();
});

test("isGeneratedAgent: only this plugin's marker, on the first frontmatter line", () => {
  expect(
    isGeneratedAgent("---\n# generated-by: opencode-squad squad-draft\nmodel: a/b\n---\n"),
  ).toBe(true);
  expect(isGeneratedAgent("---\r\n# generated-by: opencode-orchestrate x\r\n")).toBe(true);
  expect(isGeneratedAgent("---\n# generated-by: opencode-other-tool\n---\n")).toBe(false);
  expect(isGeneratedAgent("---\nmodel: a/b\n---\n# generated-by: opencode-squad\n")).toBe(false);
});
