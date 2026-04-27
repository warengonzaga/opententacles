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
    owners: z.array(z.string()),
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
  github: { owners: [] },
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
  const discordBotToken = (await secrets.get("discord.botToken")) ?? "";

  // Merge engine store onto defaults to fill any keys not yet persisted.
  const merged: AppConfig = {
    ...CONFIG_DEFAULTS,
    ...(engine.store as Partial<AppConfig>),
  };
  const config = ConfigSchema.parse(merged);

  return {
    config,
    secrets: { discord: { botToken: discordBotToken } },
    close: async () => {
      engine.close();
      await secrets.close();
    },
  };
}

export function channelConfig(
  config: AppConfig,
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
export function resolveRegisteredUser(config: AppConfig, channelName: string): string | null {
  if (channelName === "discord") return config.discord.registeredOwner ?? null;
  return null;
}
