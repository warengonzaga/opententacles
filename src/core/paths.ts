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

/**
 * Where the secrets-engine encrypted store lives.
 *
 * When `OPENTENTACLES_DATA_DIR` is set explicitly (e.g. containerized
 * deployments like Railway, where there is no usable home directory for the
 * non-root runtime user), the secrets store is scoped to a subdirectory of
 * the data dir. Otherwise it returns `undefined` so secrets-engine falls back
 * to its default shared `~/.secrets-engine/` location (preserving the local
 * dev convention of sharing the store across apps).
 */
export function resolveSecretsPath(): string | undefined {
  const explicit = process.env.OPENTENTACLES_DATA_DIR;
  if (!explicit) return undefined;
  return join(explicit, ".secrets-engine");
}
