/**
 * Purge command — wipes all OpenTentacles state for a fresh install.
 *
 * Usage:
 *   bun run purge                   → wipes ~/.opententacles/ AND OpenTentacles's
 *                                     own secret keys (Discord bot token, etc.)
 *   bun run purge -- --yes          → skip the type-to-confirm prompt
 *   bun run purge -- --fresh        → run the setup wizard after purging
 *   bun run purge -- --keep-secrets → delete data dir only; keep secret keys
 *
 * The shared `~/.secrets-engine/` store is NEVER touched as a whole — only
 * the specific keys owned by OpenTentacles (see SECRET_KEYS in core/config.ts)
 * are deleted via `SecretsEngine.delete(key)`. Other apps using the same
 * store are unaffected.
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createInterface } from "node:readline";
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

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function deleteDataDir(path: string): Promise<boolean> {
  if (!existsSync(path)) {
    console.log(`  ○ data dir: nothing to remove (${path})`);
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
      console.error(`  ✗ data dir: partial failure — ${path} still exists`);
      return false;
    }
    console.log(`  ✓ data dir: removed (${path})`);
    return true;
  } catch (err) {
    console.error(
      `  ✗ data dir: failed to remove ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

async function deleteOwnSecrets(): Promise<boolean> {
  let engine: SecretsEngine;
  try {
    engine = await SecretsEngine.open();
  } catch (err) {
    console.error(
      `  ✗ secrets: failed to open store: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }

  let allOk = true;
  try {
    for (const key of SECRET_KEYS) {
      try {
        const existed = await engine.delete(key);
        if (existed) {
          console.log(`  ✓ secret: deleted "${key}"`);
        } else {
          console.log(`  ○ secret: "${key}" not set — skipped`);
        }
      } catch (err) {
        allOk = false;
        console.error(
          `  ✗ secret: failed to delete "${key}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } finally {
    await engine.close().catch(() => {});
  }
  return allOk;
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const dataDir = resolveDataDir();
  const dataExists = existsSync(dataDir);

  console.log("OpenTentacles — purge\n");
  console.log("Targets:");
  console.log(`  • ${dataDir}${dataExists ? "" : "  (not present — skipped)"}`);
  if (flags.keepSecrets) {
    console.log("  • secret keys will be KEPT (--keep-secrets)");
  } else {
    console.log("  • OpenTentacles-owned secret keys in the shared secrets-engine store:");
    for (const k of SECRET_KEYS) console.log(`      - "${k}"`);
    console.log("    (other apps' secrets are not touched)");
  }
  console.log();

  if (!flags.yes) {
    const answer = await ask(`Type "${CONFIRM_PHRASE}" to confirm: `);
    if (answer.toLowerCase() !== CONFIRM_PHRASE) {
      console.log("Aborted.");
      process.exit(1);
    }
  }

  console.log("\nPurging...");
  const results: boolean[] = [];
  results.push(await deleteDataDir(dataDir));
  if (!flags.keepSecrets) {
    results.push(await deleteOwnSecrets());
  }

  const ok = results.every(Boolean);
  if (!ok) {
    console.error("\nPurge completed with errors. See above.");
    process.exit(2);
  }

  console.log("\nPurge complete.");

  if (flags.fresh) {
    console.log("\nRunning setup wizard...\n");
    await import("./setup.ts");
  } else {
    console.log("Run `bun run setup` when you're ready to reconfigure.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
