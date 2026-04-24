import { parse as parseToml } from "smol-toml";
import { z } from "zod";

const ConfigSchema = z.object({
  copilot: z.object({
    model: z.string().default("gpt-4.1"),
    idle_timeout_minutes: z.number().int().positive().default(30),
  }),
  channels: z.object({
    enabled: z.array(z.string()).default([]),
  }).catchall(z.unknown()),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export interface Env {
  copilotGithubToken: string | undefined;
  discordBotToken: string | undefined;
  logLevel: string;
  configPath: string;
}

export function loadEnv(): Env {
  return {
    copilotGithubToken: Bun.env.COPILOT_GITHUB_TOKEN,
    discordBotToken: Bun.env.DISCORD_BOT_TOKEN,
    logLevel: Bun.env.LOG_LEVEL ?? "info",
    configPath: Bun.env.CONFIG_PATH ?? "./config.toml",
  };
}

export async function loadConfig(path: string): Promise<AppConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(
      `Config file not found at ${path}. Copy config.example.toml to config.toml and edit it.`,
    );
  }
  const text = await file.text();
  const raw = parseToml(text);
  return ConfigSchema.parse(raw);
}

export function channelConfig(cfg: AppConfig, name: string): unknown {
  const section = (cfg.channels as Record<string, unknown>)[name];
  return section ?? {};
}
