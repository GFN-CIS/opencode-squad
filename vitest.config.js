import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    coverage: {
      provider: "v8",
      // Scoped to src/ on purpose: this is the pure decision-logic layer the
      // codebase deliberately separates from .opencode/plugins/orchestrate.js
      // (SDK-client/event plumbing) — see the module comments in
      // src/rate-limit-guard.js. Unit-testing the plugin file would mean
      // mocking the whole opencode SDK client; that's a distinct, much larger
      // effort, not something to fold in silently by widening this glob.
      include: ["src/**/*.js"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
      reporter: ["text", "lcov"],
    },
  },
});
