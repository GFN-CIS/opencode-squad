// Which outbound requests an offline integration run may attempt. Every
// fetch is blocked (setup.js); this decides which blocked attempts are
// expected and which mean a model call bypassed TestLLM. An allowlist, not a
// pattern for inference routes: a provider path nobody thought of (the
// ChatGPT backend's /backend-api/codex/responses, say) must fail the run.

/** GETs the host and the plugin make on their own, none of them inference. */
const EXPECTED = [
  // squad_metrics refresh at plugin start.
  { host: "superindex.app", path: /^\/api\/v1\/models\.json$/ },
  { host: "api.llmbenchmark.ai", path: /^\/v1\/(models|scores)$/ },
  // The host's discovery of local model servers (Ollama, LM Studio, vLLM).
  { host: "127.0.0.1:11434", path: /^\/api\/tags$/ },
  { host: "127.0.0.1:1234", path: /^\/api\/v1\/models$/ },
  { host: "127.0.0.1:8000", path: /^\/health$/ },
];

/**
 * The attempts that are not on the list: each is a request that should never
 * leave an offline run, inference above all.
 *
 * @param {Array<{url: string, method: string}>} attempts
 * @returns {string[]}  "METHOD url" per unexpected attempt
 */
export function unexpectedRequests(attempts) {
  return attempts
    .filter(({ url, method }) => {
      const u = new URL(url);
      return !(
        method === "GET" && EXPECTED.some((e) => e.host === u.host && e.path.test(u.pathname))
      );
    })
    .map(({ url, method }) => `${method} ${url}`);
}
