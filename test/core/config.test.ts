import { describe, expect, test } from "bun:test";
import { buildAppSecrets, channelConfig } from "../../src/core/config.ts";

describe("buildAppSecrets", () => {
  test("applies defaults when optional keys are missing", () => {
    const secrets = buildAppSecrets({});
    expect(secrets.copilotModel).toBe("gpt-4.1");
    expect(secrets.copilotIdleTimeoutMinutes).toBe(30);
    expect(secrets.channelsEnabled).toEqual([]);
    expect(secrets.discord.allowlist).toEqual([]);
    expect(secrets.logLevel).toBe("info");
  });

  test("throws for non-positive idle timeout", () => {
    expect(() =>
      buildAppSecrets({ "copilot.idleTimeoutMinutes": "-5" }),
    ).toThrow();
  });

  test("throws for non-integer idle timeout", () => {
    expect(() =>
      buildAppSecrets({ "copilot.idleTimeoutMinutes": "abc" }),
    ).toThrow();
  });

  test("parses channels.enabled JSON array", () => {
    const secrets = buildAppSecrets({ "channels.enabled": '["discord"]' });
    expect(secrets.channelsEnabled).toEqual(["discord"]);
  });

  test("parses discord.allowlist JSON array", () => {
    const secrets = buildAppSecrets({ "discord.allowlist": '["123456"]' });
    expect(secrets.discord.allowlist).toEqual(["123456"]);
  });

  test("accepts custom model and timeout", () => {
    const secrets = buildAppSecrets({
      "copilot.model": "gpt-4o",
      "copilot.idleTimeoutMinutes": "60",
    });
    expect(secrets.copilotModel).toBe("gpt-4o");
    expect(secrets.copilotIdleTimeoutMinutes).toBe(60);
  });
});

describe("channelConfig", () => {
  test("returns channel-specific config object", () => {
    const secrets = buildAppSecrets({
      "discord.botToken": "bot-tok",
      "discord.allowlist": '["123"]',
    });
    expect(channelConfig(secrets, "discord")).toEqual({
      botToken: "bot-tok",
      allowlist: ["123"],
    });
  });

  test("returns empty object for unknown channel", () => {
    const secrets = buildAppSecrets({});
    expect(channelConfig(secrets, "telegram")).toEqual({});
  });
});
