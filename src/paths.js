// OpenCode's own config and data locations, resolved the way opencode itself
// resolves them: XDG base dir when the env var is set (an empty string counts
// as unset — same `||` semantics as cacheDir in src/benchmark-cache.js), else
// the dotdir under the home directory. OpenCode appends "opencode" to whichever
// base it lands on (verified: XDG_CONFIG_HOME=/x `opencode debug paths` → /x/opencode).

import path from "node:path";

/**
 * Global config dir opencode reads (`<XDG_CONFIG_HOME|$HOME/.config>/opencode`).
 *
 * @param {Record<string, string|undefined>} env
 * @param {string} home
 */
export function opencodeConfigDir(env, home) {
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode");
}

/**
 * Global data dir opencode writes (`<XDG_DATA_HOME|$HOME/.local/share>/opencode`).
 *
 * @param {Record<string, string|undefined>} env
 * @param {string} home
 */
export function opencodeDataDir(env, home) {
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "opencode");
}
