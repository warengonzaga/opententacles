import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Root directory where OpenTentacles persists all host-side state.
 * Mirrors tinyclaw's convention: `~/.opententacles` by default, overridable
 * via the `OPENTENTACLES_DATA_DIR` env var.
 */
export function resolveDataDir(): string {
  return (
    process.env.OPENTENTACLES_DATA_DIR ?? join(homedir(), ".opententacles")
  );
}

/** Where Copilot is allowed to operate — cloned repos live here. */
export function resolveWorkspaceDir(): string {
  return join(resolveDataDir(), "repo");
}

/** Where the config-engine SQLite file lives. */
export function resolveConfigDir(): string {
  return join(resolveDataDir(), "data");
}
