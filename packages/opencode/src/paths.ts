/**
 * Config-path resolution for the OpenCode integration.
 *
 * The global user config lives at `<config-dir>/opencode/opencode.json`; the
 * project config lives in the repo directory. Config dirs are JSON or JSONC —
 * the reader side (`parseJsonc`) handles both.
 */
import { homedir } from "node:os";
import path from "node:path";

/**
 * Absolute global config path: `<XDG_CONFIG_HOME>/opencode/opencode.json` when
 * `XDG_CONFIG_HOME` is set, otherwise `<home>/.config/opencode/opencode.json`.
 */
export function globalOpencodeConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  const configHome = env.XDG_CONFIG_HOME;
  if (typeof configHome === "string" && configHome.length > 0) {
    return path.join(configHome, "opencode", "opencode.json");
  }
  return path.join(home, ".config", "opencode", "opencode.json");
}

/** Absolute project config path: `<dir>/opencode.json`. */
export function projectOpencodeConfigPath(dir: string): string {
  return path.join(dir, "opencode.json");
}
