import { defineConfig } from "vitest/config";

// Offline integration suite: the real OpenCode 2 host with TestLLM in place of
// the model (tests-integration/). Kept out of the unit run and its coverage:
// it boots a whole host per file, needs Node >= 24 (OpenCode's util uses
// `await using`), and checks wiring rather than decision logic.
export default defineConfig({
  test: {
    include: ["tests-integration/**/*.test.js"],
    setupFiles: ["tests-integration/setup.js"],
    pool: "forks",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
