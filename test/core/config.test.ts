import { describe, expect, test } from "bun:test";
import { CONFIG_DEFAULTS, ConfigSchema, channelConfig, type AppConfig, type AppSecrets } from "../../src/core/config.ts";

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
      ConfigSchema.parse({ ...CONFIG_DEFAULTS, copilot: { model: "x", idleTimeoutMinutes: -5 } }),
    ).toThrow();
  });

  test("rejects non-integer idle timeout", () => {
    expect(() =>
      ConfigSchema.parse({ ...CONFIG_DEFAULTS, copilot: { model: "x", idleTimeoutMinutes: 1.5 } }),
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
