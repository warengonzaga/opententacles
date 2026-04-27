import { mkdirSync } from "node:fs";
import { ConfigEngine } from "@wgtechlabs/config-engine";
import { SecretsEngine } from "@wgtechlabs/secrets-engine";
import { z } from "zod";
import { resolveConfigDir } from "./paths.ts";

/**
 * Non-secret configuration — stored by `@wgtechlabs/config-engine` in a SQLite
 * file under `<dataDir>/data/config.db`. These values are safe to keep in
 * plaintext on the host.
 */
export const ConfigSchema = z.object({
  copilot: z.object({
    model: z.string(),
    idleTimeoutMinutes: z.number().int().positive(),
  }),
  channels: z.object({
    enabled: z.array(z.string()),
  }),
  discord: z.object({
    registeredOwner: z.string().optional(),
  }),
  log: z.object({
    level: z.enum(["debug", "info", "warn", "error", "silent"]),
    format: z.enum(["text", "json"]),
  }),
  github: z.object({
    namespaces: z.array(z.string()),
  }),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

/** Every secret key Open Tentacles stores in `@wgtechlabs/secrets-engine`. */
export const SECRET_KEYS = ["discord.botToken"] as const;

export const CONFIG_DEFAULTS: AppConfig = {
  copilot: { model: "gpt-4.1", idleTimeoutMinutes: 30 },
  channels: { enabled: ["discord"] },
  discord: { registeredOwner: undefined },
  log: { level: "info", format: "text" },
  github: { namespaces: [] },
};

/**
 * Secrets — stored encrypted by `@wgtechlabs/secrets-engine`. Only things that
 * would cause real harm if leaked go here.
 */
export interface AppSecrets {
  discord: { botToken: string };
}

export interface LoadedConfig {
  config: AppConfig;
  secrets: AppSecrets;
  close(): Promise<void>;
}

/**
 * Reads environment variables and returns a partial config + secrets override.
 * Env vars take priority over stored config/secrets, enabling Railway-style
 * deployments where secrets are injected at runtime.
 *
 * Supported env vars:
 *   DISCORD_BOT_TOKEN          — discord bot secret
 *   DISCORD_OWNER_ID           — restrict bot to one Discord user ID
 *   GITHUB_NAMESPACES          — comma-separated GitHub orgs/users you own
 *   OPENTENTACLES_LOG_LEVEL    — debug | info | warn | error | silent
 *   OPENTENTACLES_DATA_DIR     — override data directory (handled in paths.ts)
 */
export function readEnvOverrides(): {
  config: Partial<AppConfig>;
  discordBotToken: string | null;
} {
  const overrides: Partial<AppConfig> = {};

  const logLevel = Bun.env.OPENTENTACLES_LOG_LEVEL;
  if (logLevel) {
    const parsed = ConfigSchema.shape.log.shape.level.safeParse(logLevel);
    if (parsed.success)
      overrides.log = { level: parsed.data } as AppConfig["log"];
  }

  const discordOwnerId = Bun.env.DISCORD_OWNER_ID;
  if (discordOwnerId) {
    overrides.discord = { registeredOwner: discordOwnerId };
  }

  const namespacesRaw = Bun.env.GITHUB_NAMESPACES;
  if (namespacesRaw) {
    overrides.github = {
      namespaces: namespacesRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }

  const discordBotToken = Bun.env.DISCORD_BOT_TOKEN ?? null;

  return { config: overrides, discordBotToken };
}

export async function loadConfig(): Promise<LoadedConfig> {
  const configDir = resolveConfigDir();
  mkdirSync(configDir, { recursive: true });

  const engine = await ConfigEngine.open<AppConfig>({
    projectName: "opententacles",
    cwd: configDir,
    defaults: CONFIG_DEFAULTS,
    schema: ConfigSchema,
  });

  const secrets = await SecretsEngine.open();
  const storedBotToken = (await secrets.get("discord.botToken")) ?? "";

  const envOverrides = readEnvOverrides();

  // Backwards-compat migration: github.owners (old key) → github.namespaces
  const storeRaw = engine.store as Record<string, unknown>;
  const githubRaw = storeRaw["github"] as Record<string, unknown> | undefined;
  if (githubRaw && !githubRaw["namespaces"] && Array.isArray(githubRaw["owners"])) {
    githubRaw["namespaces"] = githubRaw["owners"];
  }

  // Priority: env vars > stored config > defaults
  // All nested objects are merged explicitly so a partial override doesn't wipe sibling keys.
  const store = engine.store as Partial<AppConfig>;
  const env = envOverrides.config;
  const merged: AppConfig = {
    copilot: {
      ...CONFIG_DEFAULTS.copilot,
      ...(store.copilot ?? {}),
      ...(env.copilot ?? {}),
    },
    channels: {
      ...CONFIG_DEFAULTS.channels,
      ...(store.channels ?? {}),
      ...(env.channels ?? {}),
    },
    log: {
      ...CONFIG_DEFAULTS.log,
      ...(store.log ?? {}),
      ...(env.log ?? {}),
    },
    discord: {
      ...CONFIG_DEFAULTS.discord,
      ...(store.discord ?? {}),
      ...(env.discord ?? {}),
    },
    github: {
      ...CONFIG_DEFAULTS.github,
      ...(store.github ?? {}),
      ...(env.github ?? {}),
    },
  };
  const config = ConfigSchema.parse(merged);

  // Env var token takes priority over the encrypted store
  const discordBotToken = envOverrides.discordBotToken ?? storedBotToken;
  // Treat whitespace-only tokens as unset so non-Discord deployments aren't blocked.
  const effectiveDiscordToken = discordBotToken.trim();

  // If a Discord bot token is present AND Discord is enabled, an owner ID is required —
  // otherwise the bot is open to anyone, burning the operator's Copilot quota.
  if (
    effectiveDiscordToken &&
    config.channels.enabled.includes("discord") &&
    !config.discord.registeredOwner
  ) {
    await secrets.close();
    engine.close();
    throw new Error(
      "Discord bot token is set but no owner ID is configured.\n" +
        "Set DISCORD_OWNER_ID (env) or run `opententacles setup` to register an owner.",
    );
  }

  return {
    config,
    secrets: { discord: { botToken: effectiveDiscordToken } },
    close: async () => {
      engine.close();
      await secrets.close();
    },
  };
}

export function channelConfig(
  _config: AppConfig,
  secrets: AppSecrets,
  name: string,
): unknown {
  if (name === "discord") {
    return { botToken: secrets.discord.botToken };
  }
  return {};
}

/**
 * Returns the single authorized user ID for the given channel, or null if none
 * is registered (unrestricted). The framework uses this to populate
 * `ChannelContext.registeredUserId` so channels don't parse config themselves.
 */
export function resolveRegisteredUser(
  config: AppConfig,
  channelName: string,
): string | null {
  if (channelName === "discord") return config.discord.registeredOwner ?? null;
  return null;
}
