// Package entry for both OpenCode generations (OpenCode 1 >= 1.18.29).
//
// OpenCode 2 calls `setup` (.opencode/plugins/orchestrate-v2.js). OpenCode 1
// calls `server`, which lazy-imports the V1 entry: that module imports
// `@opencode-ai/plugin`, which an OpenCode 2 host does not provide, so it must
// never load there.
import v2 from "./.opencode/plugins/orchestrate-v2.js";

export default {
  ...v2,
  async server(input, options) {
    const { OrchestratePlugin } = await import("./.opencode/plugins/orchestrate.js");
    return OrchestratePlugin(input, options);
  },
};
