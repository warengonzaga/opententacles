import { mkdirSync } from "node:fs";
import * as p from "@clack/prompts";
import { ConfigEngine } from "@wgtechlabs/config-engine";
import { SecretsEngine } from "@wgtechlabs/secrets-engine";
import {
  type AppConfig,
  CONFIG_DEFAULTS,
  ConfigSchema,
} from "./core/config.ts";
import {
  resolveConfigDir,
  resolveDataDir,
  resolveWorkspaceDir,
} from "./core/paths.ts";

function parseList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function setupCommand(): Promise<void> {
  p.intro("Open Tentacles — setup");

  p.note(
    [
      `Data dir : ${resolveDataDir()}`,
      `Workspace: ${resolveWorkspaceDir()}`,
      `Config db: ${resolveConfigDir()}`,
    ].join("\n"),
    "Paths",
  );

  p.log.info(
    "Copilot auth uses your existing `gh` CLI login — no token needed.",
  );
  p.log.info("Secrets stored encrypted via @wgtechlabs/secrets-engine.");

  // Open config engine early so we can read existing values for the overwrite guard.
  mkdirSync(resolveConfigDir(), { recursive: true });
  const engine = await ConfigEngine.open<AppConfig>({
    projectName: "opententacles",
    cwd: resolveConfigDir(),
    defaults: CONFIG_DEFAULTS,
    schema: ConfigSchema,
  });

  const cancel = (msg = "Setup cancelled.") => {
    engine.close();
    p.outro(msg);
  };

  // --- Discord ---
  const discordToken = await p.password({ message: "Discord bot token:" });
  if (p.isCancel(discordToken)) {
    cancel();
    return;
  }

  const ownerIdRaw = await p.text({
    message: "Discord registered owner user ID (one user only):",
    placeholder: "blank = no restriction",
  });
  if (p.isCancel(ownerIdRaw)) {
    cancel();
    return;
  }

  const newUserId = (ownerIdRaw as string).trim() || undefined;
  const existingOwner = engine.get("discord.registeredOwner") as
    | string
    | undefined;

  if (newUserId && existingOwner && existingOwner !== newUserId) {
    const overwrite = await p.confirm({
      message: `User ${existingOwner} is already registered. Replace with ${newUserId}?`,
      initialValue: false,
    });
    if (p.isCancel(overwrite) || !overwrite) {
      cancel("Keeping existing registered owner.");
      return;
    }
  }

  // --- General config ---
  const channelsRaw = await p.text({
    message: "Enabled channels (comma-separated):",
    placeholder: "discord",
    defaultValue: "discord",
  });
  if (p.isCancel(channelsRaw)) {
    cancel();
    return;
  }

  const model = await p.text({
    message: "Copilot model:",
    placeholder: "gpt-4.1",
    defaultValue: "gpt-4.1",
  });
  if (p.isCancel(model)) {
    cancel();
    return;
  }

  const idleTimeout = await p.text({
    message: "Idle session timeout (minutes):",
    placeholder: "30",
    defaultValue: "30",
    validate: (v) => {
      if (!v) return "Enter a positive integer.";
      const n = Number.parseInt(v, 10);
      if (!Number.isInteger(n) || n <= 0) return "Enter a positive integer.";
    },
  });
  if (p.isCancel(idleTimeout)) {
    cancel();
    return;
  }

  const logLevel = await p.select({
    message: "Log level:",
    options: [
      { value: "info", label: "info", hint: "recommended" },
      { value: "debug", label: "debug" },
      { value: "warn", label: "warn" },
      { value: "error", label: "error" },
      { value: "silent", label: "silent" },
    ],
  });
  if (p.isCancel(logLevel)) {
    cancel();
    return;
  }

  const logFormat = await p.select({
    message: "Log format:",
    options: [
      { value: "text", label: "text", hint: "human-readable" },
      { value: "json", label: "json", hint: "machine-readable" },
    ],
  });
  if (p.isCancel(logFormat)) {
    cancel();
    return;
  }

  const ownersRaw = await p.text({
    message: "GitHub namespaces you control (comma-separated orgs/users):",
    placeholder: "blank to skip",
  });
  if (p.isCancel(ownersRaw)) {
    cancel();
    return;
  }

  // --- Save ---
  const s = p.spinner();
  s.start("Saving configuration...");

  try {
    const secrets = await SecretsEngine.open();
    try {
      if (discordToken)
        await secrets.set("discord.botToken", discordToken as string);
    } finally {
      await secrets.close();
    }

    const channels = parseList(channelsRaw as string);
    const owners = parseList((ownersRaw as string) ?? "");

    // Setting undefined clears the key, effectively removing the restriction.
    engine.set("discord.registeredOwner", newUserId);
    engine.set("channels.enabled", channels);
    engine.set("github.namespaces", owners);
    engine.set("copilot.model", model as string);
    const n = Number.parseInt(idleTimeout as string, 10);
    if (Number.isInteger(n) && n > 0)
      engine.set("copilot.idleTimeoutMinutes", n);
    engine.set("log.level", logLevel as string);
    engine.set("log.format", logFormat as string);

    await engine.flush();
    engine.close();

    mkdirSync(resolveWorkspaceDir(), { recursive: true });

    s.stop("Configuration saved.");
  } catch (err) {
    s.stop("Failed to save configuration.");
    p.log.error(err instanceof Error ? err.message : String(err));
    engine.close();
    process.exit(1);
  }

  p.outro("Setup complete! Run `opententacles start` to launch.");
}
