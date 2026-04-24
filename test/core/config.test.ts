import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelConfig, loadConfig } from "../../src/core/config.ts";

function writeTempConfig(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "opententacles-cfg-"));
  const path = join(dir, "config.toml");
  writeFileSync(path, body);
  return path;
}

describe("loadConfig", () => {
  test("parses a minimal valid config and applies defaults", async () => {
    const path = writeTempConfig(`
[copilot]

[channels]
enabled = ["discord"]

[channels.discord]
allowlist = ["123"]
`);
    const cfg = await loadConfig(path);
    expect(cfg.copilot.model).toBe("gpt-4.1");
    expect(cfg.copilot.idle_timeout_minutes).toBe(30);
    expect(cfg.channels.enabled).toEqual(["discord"]);
    expect(channelConfig(cfg, "discord")).toEqual({ allowlist: ["123"] });
  });

  test("rejects a config with an invalid idle timeout", async () => {
    const path = writeTempConfig(`
[copilot]
idle_timeout_minutes = -5

[channels]
enabled = []
`);
    await expect(loadConfig(path)).rejects.toThrow();
  });

  test("returns empty object for unknown channel section", async () => {
    const path = writeTempConfig(`
[copilot]

[channels]
enabled = []
`);
    const cfg = await loadConfig(path);
    expect(channelConfig(cfg, "telegram")).toEqual({});
  });

  test("throws a helpful error when the file is missing", async () => {
    await expect(loadConfig("/nonexistent/does-not-exist.toml")).rejects.toThrow(/not found/);
  });
});
