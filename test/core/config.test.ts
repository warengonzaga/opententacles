import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type AppConfig,
  type AppSecrets,
  CONFIG_DEFAULTS,
  ConfigSchema,
  channelConfig,
  readEnvOverrides,
} from "../../src/core/config.ts";

describe("ConfigSchema + CONFIG_DEFAULTS", () => {
  test("CONFIG_DEFAULTS is valid against the schema", () => {
    const cfg = ConfigSchema.parse(CONFIG_DEFAULTS);
    expect(cfg.copilot.model).toBe("gpt-4.1");
    expect(cfg.copilot.idleTimeoutMinutes).toBe(30);
    expect(cfg.channels.enabled).toEqual(["discord"]);
    expect(cfg.discord.registeredOwner).toBeUndefined();
    expect(cfg.log.level).toBe("info");
    expect(cfg.log.format).toBe("text");
    expect(cfg.github.namespaces).toEqual([]);
  });

  test("rejects non-positive idle timeout", () => {
    expect(() =>
      ConfigSchema.parse({
        ...CONFIG_DEFAULTS,
        copilot: { model: "x", idleTimeoutMinutes: -5 },
      }),
    ).toThrow();
  });

  test("rejects non-integer idle timeout", () => {
    expect(() =>
      ConfigSchema.parse({
        ...CONFIG_DEFAULTS,
        copilot: { model: "x", idleTimeoutMinutes: 1.5 },
      }),
    ).toThrow();
  });

  test("rejects unknown log level", () => {
    expect(() =>
      ConfigSchema.parse({
        ...CONFIG_DEFAULTS,
        log: { level: "trace" as unknown as "info", format: "text" },
      }),
    ).toThrow();
  });

  test("accepts custom values", () => {
    const cfg: AppConfig = ConfigSchema.parse({
      copilot: { model: "gpt-4o", idleTimeoutMinutes: 60 },
      channels: { enabled: ["discord", "telegram"] },
      discord: { registeredOwner: "123" },
      log: { level: "debug", format: "json" },
      github: { namespaces: ["warengonzaga"] },
    });
    expect(cfg.copilot.model).toBe("gpt-4o");
    expect(cfg.copilot.idleTimeoutMinutes).toBe(60);
    expect(cfg.channels.enabled).toEqual(["discord", "telegram"]);
    expect(cfg.discord.registeredOwner).toBe("123");
    expect(cfg.log.level).toBe("debug");
    expect(cfg.log.format).toBe("json");
    expect(cfg.github.namespaces).toEqual(["warengonzaga"]);
  });
});

describe("channelConfig", () => {
  const config: AppConfig = {
    ...CONFIG_DEFAULTS,
    discord: { registeredOwner: "123" },
  };
  const secrets: AppSecrets = { discord: { botToken: "bot-tok" } };

  test("returns discord channel config from merged stores", () => {
    expect(channelConfig(config, secrets, "discord")).toEqual({
      botToken: "bot-tok",
    });
  });

  test("returns empty object for unknown channel", () => {
    expect(channelConfig(config, secrets, "telegram")).toEqual({});
  });
});

describe("readEnvOverrides", () => {
  const envBackup: Record<string, string | undefined> = {};
  const envKeys = [
    "OPENTENTACLES_LOG_LEVEL",
    "DISCORD_OWNER_ID",
    "GITHUB_NAMESPACES",
    "DISCORD_BOT_TOKEN",
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      envBackup[key] = Bun.env[key];
      delete Bun.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (envBackup[key] === undefined) {
        delete Bun.env[key];
      } else {
        Bun.env[key] = envBackup[key];
      }
    }
  });

  test("returns empty overrides and null token when no env vars are set", () => {
    const result = readEnvOverrides();
    expect(result.config).toEqual({});
    expect(result.discordBotToken).toBeNull();
  });

  test("sets only log.level and does not wipe log.format", () => {
    Bun.env.OPENTENTACLES_LOG_LEVEL = "debug";
    const result = readEnvOverrides();
    // Only level should be set; format is intentionally absent so the merge
    // in loadConfig can apply the stored/default format.
    expect(result.config.log as unknown).toEqual({ level: "debug" });
    expect(
      (result.config.log as Record<string, unknown>).format,
    ).toBeUndefined();
  });

  test("ignores invalid log level", () => {
    Bun.env.OPENTENTACLES_LOG_LEVEL = "trace";
    const result = readEnvOverrides();
    expect(result.config.log).toBeUndefined();
  });

  test("sets discord.registeredOwner from DISCORD_OWNER_ID", () => {
    Bun.env.DISCORD_OWNER_ID = "user-123";
    const result = readEnvOverrides();
    expect(result.config.discord).toEqual({ registeredOwner: "user-123" });
  });

  test("splits and trims GITHUB_NAMESPACES", () => {
    Bun.env.GITHUB_NAMESPACES = "warengonzaga, wgtechlabs, ";
    const result = readEnvOverrides();
    expect(result.config.github?.namespaces).toEqual([
      "warengonzaga",
      "wgtechlabs",
    ]);
  });

  test("captures DISCORD_BOT_TOKEN", () => {
    Bun.env.DISCORD_BOT_TOKEN = "secret-tok";
    const result = readEnvOverrides();
    expect(result.discordBotToken).toBe("secret-tok");
  });
});

describe("loadConfig owner requirement", () => {
  test("ConfigSchema allows discord without registeredOwner", () => {
    const cfg: AppConfig = ConfigSchema.parse({
      ...CONFIG_DEFAULTS,
      discord: {},
    });
    expect(cfg.discord.registeredOwner).toBeUndefined();
  });
});
