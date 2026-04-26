import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { ConfigEngine } from "@wgtechlabs/config-engine";
import { SecretsEngine } from "@wgtechlabs/secrets-engine";
import { ConfigSchema, CONFIG_DEFAULTS, type AppConfig } from "./core/config.ts";
import { resolveConfigDir, resolveDataDir, resolveWorkspaceDir } from "./core/paths.ts";

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function parseList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main(): Promise<void> {
  console.log("OpenTentacles — setup\n");
  console.log(`Data dir : ${resolveDataDir()}`);
  console.log(`Workspace : ${resolveWorkspaceDir()}`);
  console.log(`Config db : ${resolveConfigDir()}\n`);
  console.log("Copilot auth uses your existing `gh` CLI login — no token needed.");
  console.log("Secrets are stored encrypted via @wgtechlabs/secrets-engine.");
  console.log("Non-secret config is stored via @wgtechlabs/config-engine.\n");

  const discordToken = await ask("Discord bot token: ");
  const allowlistRaw = await ask("Discord user IDs to allowlist (comma-separated, blank = open): ");
  const channelsRaw = await ask("Enabled channels (comma-separated, default: discord): ");
  const model = await ask("Copilot model (default: gpt-4.1): ");
  const idleTimeout = await ask("Idle session timeout in minutes (default: 30): ");
  const logLevel = await ask("Log level — debug/info/warn/error/silent (default: info): ");
  const logFormat = await ask("Log format — text/json (default: text): ");
  const ownersRaw = await ask("GitHub owners you control (comma-separated; repos under these land in repo/<owner>/<name>): ");

  // --- Secrets ---
  const secrets = await SecretsEngine.open();
  if (discordToken) await secrets.set("discord.botToken", discordToken);
  await secrets.close();

  // --- Config ---
  mkdirSync(resolveConfigDir(), { recursive: true });
  const engine = await ConfigEngine.open<AppConfig>({
    projectName: "opententacles",
    cwd: resolveConfigDir(),
    defaults: CONFIG_DEFAULTS,
    schema: ConfigSchema,
  });

  const channels = channelsRaw ? parseList(channelsRaw) : ["discord"];
  const allowlist = parseList(allowlistRaw);
  const owners = parseList(ownersRaw);

  engine.set("channels.enabled", channels);
  engine.set("discord.allowlist", allowlist);
  engine.set("github.owners", owners);
  if (model) engine.set("copilot.model", model);
  if (idleTimeout) {
    const n = Number.parseInt(idleTimeout, 10);
    if (Number.isInteger(n) && n > 0) engine.set("copilot.idleTimeoutMinutes", n);
  }
  if (logLevel) engine.set("log.level", logLevel);
  if (logFormat) engine.set("log.format", logFormat);

  await engine.flush();
  engine.close();

  // Pre-create workspace dir so Copilot has somewhere to operate.
  mkdirSync(resolveWorkspaceDir(), { recursive: true });

  console.log("\nSetup complete. Run `bun run start` to launch OpenTentacles.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
