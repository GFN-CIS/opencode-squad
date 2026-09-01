import { expect, test } from "vitest";
import { formatTaskOutcome, isTaskResultEmpty } from "../src/task-outcome.js";

// The real numbers from ses_fa3e7d7a6ffenuME30B4y0It5x (glm-5.3) — the case
// that made the orchestrator announce a provider outage.
const TRUNCATED_IN_REASONING = {
  taskId: "ses_fa3e7d7a6ffenuME30B4y0It5x",
  providerModelId: "zai-coding-plan/glm-5.3",
  finish: "length",
  outputTokens: 9,
  reasoningTokens: 31991,
  resultEmpty: true,
};

test("formatTaskOutcome says nothing when a normal finish produced a result", () => {
  expect(
    formatTaskOutcome({
      taskId: "ses_ok",
      providerModelId: "anthropic/claude-sonnet-5",
      finish: "tool-calls",
      outputTokens: 400,
      reasoningTokens: 0,
      resultEmpty: false,
    }),
  ).toBe("");
});

test("formatTaskOutcome names max_tokens, not a provider failure, on an empty truncated result", () => {
  const s = formatTaskOutcome(TRUNCATED_IN_REASONING);
  expect(s).toContain("[TASK OUTCOME]");
  expect(s).toContain("task_id=ses_fa3e7d7a6ffenuME30B4y0It5x");
  expect(s).toContain("zai-coding-plan/glm-5.3");
  expect(s).toContain("max_tokens (finish=length; 9 tokens output, 31991 tokens reasoning)");
  expect(s).toContain("not because the provider refused");
  expect(s).toContain("Do not switch providers on this signal");
});

test("formatTaskOutcome points at the reasoning channel when reasoning ate the budget", () => {
  expect(formatTaskOutcome(TRUNCATED_IN_REASONING)).toContain("reasoning channel");
});

test("formatTaskOutcome does not blame reasoning when the output itself filled the budget", () => {
  const s = formatTaskOutcome({
    ...TRUNCATED_IN_REASONING,
    outputTokens: 32000,
    reasoningTokens: 0,
  });
  expect(s).toContain("max_tokens (finish=length; 32000 tokens output, 0 tokens reasoning)");
  expect(s).not.toContain("reasoning channel");
});

test("formatTaskOutcome flags a truncated but non-empty result as partial", () => {
  const s = formatTaskOutcome({ ...TRUNCATED_IN_REASONING, resultEmpty: false });
  expect(s).toContain("CUT OFF");
  expect(s).toContain("Treat it as partial");
  expect(s).not.toContain("Do not switch providers");
});

test("formatTaskOutcome distinguishes an empty result on a normal finish from truncation", () => {
  const s = formatTaskOutcome({
    taskId: "ses_quiet",
    providerModelId: "anthropic/claude-sonnet-5",
    finish: "stop",
    outputTokens: 3,
    reasoningTokens: 0,
    resultEmpty: true,
  });
  expect(s).toContain(
    "empty result on a normal finish (finish=stop; 3 tokens output, 0 tokens reasoning)",
  );
  expect(s).toContain("stopped rather than being cut off");
  expect(s).not.toContain("max_tokens");
});

test("formatTaskOutcome still reports with no model or token split available", () => {
  const s = formatTaskOutcome({ taskId: "ses_bare", finish: "length", resultEmpty: true });
  expect(s).toContain("task_id=ses_bare");
  expect(s).toContain("max_tokens (finish=length)");
  expect(s).not.toContain("undefined");
  expect(s).not.toContain("()");
});

test("isTaskResultEmpty reads the task_result element, not the whole tool output", () => {
  const empty = '<task id="ses_x" state="completed">\n<task_result>\n\n</task_result>\n</task>';
  expect(isTaskResultEmpty(empty)).toBe(true);
  // A previously appended [CACHE STATUS] line must not read as a result.
  expect(isTaskResultEmpty(`${empty}\n\n[CACHE STATUS] task_id=ses_x — ...`)).toBe(true);
  expect(
    isTaskResultEmpty(empty.replace("<task_result>\n\n", "<task_result>\nwrote 4 files\n")),
  ).toBe(false);
});

test("isTaskResultEmpty falls back to the raw string when there is no task_result element", () => {
  expect(isTaskResultEmpty("Tool execution aborted")).toBe(false);
  expect(isTaskResultEmpty("   ")).toBe(true);
  expect(isTaskResultEmpty(undefined)).toBe(true);
});

test("formatTaskOutcome refuses to guess when the subagent session could not be read", () => {
  const s = formatTaskOutcome({ taskId: "ses_unread", resultEmpty: true, usageUnknown: true });
  expect(s).toContain("could not be read");
  expect(s).toContain("UNKNOWN");
  expect(s).not.toContain("stopped rather than being cut off");
  expect(s).not.toContain("normal finish");
});

test("formatTaskOutcome stays silent on an unreadable session that still produced a result", () => {
  expect(formatTaskOutcome({ taskId: "ses_unread", resultEmpty: false, usageUnknown: true })).toBe(
    "",
  );
});
