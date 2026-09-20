import { describe, expect, it } from "vitest";

import {
  applySystemPromptTransform,
  createPromptLoader,
  findPromptFence,
  PROMPT_CLOSE,
  placeholderBody,
  promptOpen,
  wrapPrompt,
} from "../src/prompt-inject.js";
import { parseAgentFile } from "../src/roster.js";
import { agentMarkdown } from "../src/workers.js";

const sys = (text) => [text];

describe("findPromptFence", () => {
  it("bounds the whole fenced span, markers included", () => {
    const text = `head\n${wrapPrompt("grunt", "BODY")}\ntail`;
    const f = findPromptFence(text);
    expect(f.role).toBe("grunt");
    expect(text.slice(f.start, f.end)).toBe(wrapPrompt("grunt", "BODY"));
  });

  it("returns null without a fence, or with an unclosed one", () => {
    expect(findPromptFence("no markers here")).toBeNull();
    expect(findPromptFence(`${promptOpen("drill")}\nbody, never closed`)).toBeNull();
    expect(findPromptFence(undefined)).toBeNull();
  });
});

describe("applySystemPromptTransform", () => {
  it("swaps the fenced body for the current one, in place", () => {
    const system = sys(`preamble\n${wrapPrompt("grunt", "OLD BODY")}\n\nnotes stay`);
    const res = applySystemPromptTransform(system, () => "NEW BODY");
    expect(res).toEqual({ applied: true, role: "grunt", changed: true });
    expect(system).toHaveLength(1);
    expect(system[0]).toBe(`preamble\n${wrapPrompt("grunt", "NEW BODY")}\n\nnotes stay`);
  });

  it("is idempotent — a second fire (two plugin copies) changes nothing", () => {
    const system = sys(wrapPrompt("drill", "OLD"));
    applySystemPromptTransform(system, () => "NEW");
    const once = system[0];
    const res = applySystemPromptTransform(system, () => "NEW");
    expect(system[0]).toBe(once);
    expect(res.changed).toBe(false);
  });

  it("passes the fenced role to the loader", () => {
    const seen = [];
    applySystemPromptTransform(sys(wrapPrompt("drill", "x")), (role) => {
      seen.push(role);
      return "y";
    });
    expect(seen).toEqual(["drill"]);
  });

  it("leaves the stale body alone when the prompt cannot be read", () => {
    const original = wrapPrompt("grunt", "STALE BUT VALID");
    for (const loader of [
      () => null,
      () => "   ",
      () => {
        throw new Error("ENOENT");
      },
    ]) {
      const system = sys(original);
      expect(applySystemPromptTransform(system, loader).applied).toBe(false);
      expect(system[0]).toBe(original);
    }
  });

  it("no-ops on a prompt without our fence (sarge, hand-authored agents)", () => {
    const system = sys("You are OpenCode, the best coding agent on the planet.");
    const res = applySystemPromptTransform(system, () => "INJECTED");
    expect(res).toEqual({ applied: false });
    expect(system[0]).toBe("You are OpenCode, the best coding agent on the planet.");
  });

  it("never grows the array — an extra entry would move a cache breakpoint", () => {
    const system = sys(wrapPrompt("grunt", "OLD"));
    applySystemPromptTransform(system, () => "NEW");
    expect(system).toHaveLength(1);
  });

  it("tolerates a payload that is not a string array", () => {
    expect(applySystemPromptTransform(undefined, () => "x")).toEqual({ applied: false });
    expect(applySystemPromptTransform([], () => "x")).toEqual({ applied: false });
    expect(applySystemPromptTransform([{}], () => "x")).toEqual({ applied: false });
  });
});

describe("createPromptLoader", () => {
  it("reads once per (size, mtime) and re-reads when that changes", () => {
    let key = "1:1";
    let reads = 0;
    const load = createPromptLoader({
      statKey: () => key,
      readFile: () => `body ${++reads}`,
    });
    expect(load("grunt")).toBe("body 1");
    expect(load("grunt")).toBe("body 1");
    key = "1:2";
    expect(load("grunt")).toBe("body 2");
  });

  it("refuses a role outside the allowlist — the role comes from text", () => {
    const load = createPromptLoader({
      statKey: () => "k",
      readFile: () => "body",
    });
    expect(load("../../etc/passwd")).toBeNull();
    expect(load("sarge")).toBeNull();
  });

  it("returns null when stat or read throws", () => {
    const throwing = () => {
      throw new Error("ENOENT");
    };
    expect(createPromptLoader({ statKey: throwing, readFile: () => "b" })("grunt")).toBeNull();
    expect(createPromptLoader({ statKey: () => "k", readFile: throwing })("grunt")).toBeNull();
  });
});

describe("generated agent files carry the fence", () => {
  it("fences a placeholder — never a copy of the role prompt — with notes outside it", () => {
    const { content } = agentMarkdown("grunt", "anthropic/claude-opus-5", {
      notes: "this model over-scaffolds",
    });
    const fence = findPromptFence(content);
    expect(fence.role).toBe("grunt");
    expect(content.slice(fence.start, fence.end)).toBe(
      wrapPrompt("grunt", placeholderBody("grunt")),
    );
    expect(content.indexOf("<!-- squad:notes -->")).toBeGreaterThan(fence.end);
  });

  it("the placeholder tells an unhelped agent to stop rather than improvise", () => {
    const { content } = agentMarkdown("grunt", "a/b");
    expect(content).toContain("squad prompt missing");
    expect(content).toContain("Do not");
  });

  it("round-trips through parseAgentFile with notes and model intact", () => {
    const { content } = agentMarkdown("grunt", "anthropic/claude-opus-5", {
      variant: "high",
      description: "strong analysis",
      notes: "this model over-scaffolds",
    });
    const { modelId, entry } = parseAgentFile(content);
    expect(modelId).toBe("anthropic/claude-opus-5");
    expect(entry).toEqual({
      variant: "high",
      description: "strong analysis",
      notes: "this model over-scaffolds",
    });
    // Regenerating from what was read back must reproduce the same file — the
    // fence sits before the notes markers, which is exactly where a parser
    // reading by index could start eating them.
    const again = agentMarkdown("grunt", modelId, entry);
    expect(again.content).toBe(content);
  });

  it("the placeholder is replaced by the real prompt, notes intact", () => {
    const { content } = agentMarkdown("drill", "zai-coding-plan/glm-5.3", { notes: "keep me" });
    const system = sys(content);
    applySystemPromptTransform(system, () => "REAL ROLE BODY");
    expect(system[0]).toContain("REAL ROLE BODY");
    expect(system[0]).not.toContain("squad prompt missing");
    expect(system[0]).toContain("keep me");
    expect(system[0]).toContain(PROMPT_CLOSE);
  });
});
