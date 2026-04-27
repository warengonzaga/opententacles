/**
 * Purge command — wipes all Open Tentacles state for a fresh install.
 *
 * Usage:
 *   opententacles purge                   → wipes ~/.opententacles/ AND owned secret keys
 *   opententacles purge --yes             → skip the type-to-confirm prompt
 *   opententacles purge --fresh           → run the setup wizard after purging
 *   opententacles purge --keep-secrets    → delete data dir only; keep secret keys
 *
 * The shared `~/.secrets-engine/` store is NEVER touched as a whole — only
 * the specific keys owned by Open Tentacles (see SECRET_KEYS in core/config.ts)
 * are deleted via `SecretsEngine.delete(key)`. Other apps using the same
 * store are unaffected.
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as p from "@clack/prompts";
import { SecretsEngine } from "@wgtechlabs/secrets-engine";
import { SECRET_KEYS } from "./core/config.ts";
import { resolveDataDir } from "./core/paths.ts";

const CONFIRM_PHRASE = "goodbye opententacles";
const IS_WINDOWS = process.platform === "win32";

interface PurgeFlags {
  yes: boolean;
  fresh: boolean;
  keepSecrets: boolean;
}

function parseArgs(argv: string[]): PurgeFlags {
  const flags: PurgeFlags = { yes: false, fresh: false, keepSecrets: false };
  for (const a of argv) {
    if (a === "--yes" || a === "-y") flags.yes = true;
    else if (a === "--fresh") flags.fresh = true;
    else if (a === "--keep-secrets") flags.keepSecrets = true;
  }
  return flags;
}

async function deleteDataDir(path: string): Promise<boolean> {
  if (!existsSync(path)) {
    p.log.step(`data dir: nothing to remove (${path})`);
    return true;
  }
  try {
    await rm(path, {
      recursive: true,
      force: true,
      maxRetries: IS_WINDOWS ? 5 : 0,
      retryDelay: IS_WINDOWS ? 200 : 100,
    });
    if (existsSync(path)) {
      p.log.error(`data dir: partial failure — ${path} still exists`);
      return false;
    }
    p.log.step(`data dir: removed (${path})`);
    return true;
  } catch (err) {
    p.log.error(
      `data dir: failed to remove ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

async function deleteOwnSecrets(): Promise<boolean> {
  let engine: SecretsEngine;
  try {
    engine = await SecretsEngine.open();
  } catch (err) {
    p.log.error(
      `secrets: failed to open store: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }

  let allOk = true;
  try {
    for (const key of SECRET_KEYS) {
      try {
        const existed = await engine.delete(key);
        if (existed) {
          p.log.step(`secret: deleted "${key}"`);
        } else {
          p.log.step(`secret: "${key}" not set — skipped`);
        }
      } catch (err) {
        allOk = false;
        p.log.error(
          `secret: failed to delete "${key}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } finally {
    await engine.close().catch(() => {});
  }
  return allOk;
}

export async function purgeCommand(argv: string[]): Promise<void> {
  const flags = parseArgs(argv);
  const dataDir = resolveDataDir();
  const dataExists = existsSync(dataDir);

  p.intro("Open Tentacles — purge");

  const targetLines = [`• ${dataDir}${dataExists ? "" : "  (not present — will be skipped)"}`];
  if (flags.keepSecrets) {
    targetLines.push("• secret keys will be KEPT (--keep-secrets)");
  } else {
    targetLines.push("• Open Tentacles-owned secret keys:");
    for (const k of SECRET_KEYS) targetLines.push(`    - "${k}"`);
    targetLines.push("  (other apps' secrets are not touched)");
  }
  p.note(targetLines.join("\n"), "Targets");

  if (!flags.yes) {
    const answer = await p.text({
      message: `Type "${CONFIRM_PHRASE}" to confirm:`,
      validate: (v) => {
        if (!v || v.toLowerCase() !== CONFIRM_PHRASE) return `Type exactly: ${CONFIRM_PHRASE}`;
      },
    });
    if (p.isCancel(answer)) {
      p.outro("Purge cancelled.");
      return;
    }
  }

  const s = p.spinner();
  s.start("Purging...");

  const results: boolean[] = [];
  results.push(await deleteDataDir(dataDir));
  if (!flags.keepSecrets) {
    results.push(await deleteOwnSecrets());
  }

  const ok = results.every(Boolean);

  if (!ok) {
    s.stop("Purge completed with errors.");
    process.exit(2);
  }

  s.stop("Purge complete.");

  if (flags.fresh) {
    p.log.info("Starting setup wizard...");
    const { setupCommand } = await import("./setup.ts");
    await setupCommand();
  } else {
    p.outro("Run `opententacles setup` when you're ready to reconfigure.");
  }
}


