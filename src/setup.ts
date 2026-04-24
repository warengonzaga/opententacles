import { createInterface } from "readline";
import { SecretsEngine } from "@wgtechlabs/secrets-engine";

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  console.log("OpenTentacles — setup\n");
  console.log("Copilot auth uses your existing `gh` CLI login — no token needed.\n");
  console.log("Secrets are stored encrypted on this machine via @wgtechlabs/secrets-engine.\n");

  const discordToken = await ask("Discord bot token: ");
  const allowlistRaw = await ask("Discord user IDs to allowlist (comma-separated, blank = open): ");
  const channelsRaw = await ask("Enabled channels (comma-separated, default: discord): ");
  const model = await ask("Copilot model (default: gpt-4.1): ");
  const idleTimeout = await ask("Idle session timeout in minutes (default: 30): ");
  const logLevel = await ask("Log level — debug/info/warn/error (default: info): ");

  const engine = await SecretsEngine.open();

  await engine.set("discord.botToken", discordToken);

  const allowlist = allowlistRaw
    ? allowlistRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  await engine.set("discord.allowlist", JSON.stringify(allowlist));

  const channels = channelsRaw
    ? channelsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : ["discord"];
  await engine.set("channels.enabled", JSON.stringify(channels));

  if (model) await engine.set("copilot.model", model);
  if (idleTimeout) await engine.set("copilot.idleTimeoutMinutes", idleTimeout);
  if (logLevel) await engine.set("log.level", logLevel);

  await engine.close();

  console.log("\nSetup complete. Run `bun run start` to launch OpenTentacles.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
