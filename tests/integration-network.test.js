// Suite: tests-integration/network.js — the offline integration runs' rule
// for which blocked requests are expected. Run: npx vitest run tests/integration-network.test.js

import { expect, test } from "vitest";
import { unexpectedRequests } from "../tests-integration/network.js";

test("the expected background GETs pass", () => {
  expect(
    unexpectedRequests([
      { url: "https://superindex.app/api/v1/models.json", method: "GET" },
      { url: "https://api.llmbenchmark.ai/v1/scores?metric=valsai_index", method: "GET" },
      { url: "http://127.0.0.1:11434/api/tags", method: "GET" },
    ]),
  ).toEqual([]);
});

test("any inference route fails, including ones outside /v1", () => {
  const routes = [
    "https://chatgpt.com/backend-api/codex/responses",
    "https://api.anthropic.com/v1/messages",
    "http://127.0.0.1:11434/api/chat",
    "https://superindex.app/api/v1/models.json",
  ];
  expect(unexpectedRequests(routes.map((url) => ({ url, method: "POST" })))).toEqual(
    routes.map((u) => `POST ${u}`),
  );
});

test("an unknown host fails even as a GET", () => {
  expect(unexpectedRequests([{ url: "https://example.invalid/x", method: "GET" }])).toEqual([
    "GET https://example.invalid/x",
  ]);
});
