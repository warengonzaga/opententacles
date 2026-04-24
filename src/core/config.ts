import { SecretsEngine } from "@wgtechlabs/secrets-engine";

export interface AppSecrets {
  copilotModel: string;
  copilotIdleTimeoutMinutes: number;
  channelsEnabled: string[];
  logLevel: string;
  discord: {
    botToken: string;
    allowlist: string[];
  };
}

const SECRET_KEYS = [
  "copilot.model",
  "copilot.idleTimeoutMinutes",
  "channels.enabled",
  "log.level",
  "discord.botToken",
  "discord.allowlist",
] as const;

export function buildAppSecrets(raw: Record<string, string | null>): AppSecrets {
  const copilotModel = raw["copilot.model"] ?? "gpt-4.1";

  const idleTimeoutMinutes = parseInt(raw["copilot.idleTimeoutMinutes"] ?? "30", 10);
  if (!Number.isInteger(idleTimeoutMinutes) || idleTimeoutMinutes <= 0) {
    throw new Error("copilot.idleTimeoutMinutes must be a positive integer");
  }

  const channelsEnabled = JSON.parse(raw["channels.enabled"] ?? "[]") as string[];
  const discordAllowlist = JSON.parse(raw["discord.allowlist"] ?? "[]") as string[];
  const logLevel = raw["log.level"] ?? "info";
  const discordBotToken = raw["discord.botToken"] ?? "";

  return {
    copilotModel,
    copilotIdleTimeoutMinutes: idleTimeoutMinutes,
    channelsEnabled,
    logLevel,
    discord: {
      botToken: discordBotToken,
      allowlist: discordAllowlist,
    },
  };
}

export async function loadSecrets(): Promise<AppSecrets> {
  const engine = await SecretsEngine.open();
  try {
    const raw: Record<string, string | null> = {};
    for (const key of SECRET_KEYS) {
      raw[key] = await engine.get(key);
    }
    return buildAppSecrets(raw);
  } finally {
    await engine.close();
  }
}

export function channelConfig(secrets: AppSecrets, name: string): unknown {
  return (secrets as unknown as Record<string, unknown>)[name] ?? {};
}
