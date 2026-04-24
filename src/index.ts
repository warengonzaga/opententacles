import { approveAll, CopilotClient } from "@github/copilot-sdk";
import { channelConfig, loadSecrets, type AppSecrets } from "./core/config.ts";
import { CopilotOrchestrator, type CopilotClientLike } from "./core/copilot.ts";
import { openDb } from "./core/db.ts";
import { createLogger } from "./core/logger.ts";
import type { Channel } from "./core/types.ts";
import { discoverChannels } from "./registry.ts";

async function main(): Promise<void> {
  let secrets: AppSecrets;
  try {
    secrets = await loadSecrets();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const logger = createLogger(secrets.logLevel);
  logger.info(
    { channels: secrets.channelsEnabled, model: secrets.copilotModel },
    "opententacles starting",
  );

  openDb();

  // CopilotClient reads COPILOT_GITHUB_TOKEN from the environment
  process.env["COPILOT_GITHUB_TOKEN"] = secrets.copilotGithubToken;
  const client = new CopilotClient() as unknown as CopilotClientLike;
  const orchestrator = new CopilotOrchestrator({
    client,
    model: secrets.copilotModel,
    idleTimeoutMs: secrets.copilotIdleTimeoutMinutes * 60_000,
    permissionHandler: approveAll,
    logger: logger.child({ component: "copilot" }),
  });
  orchestrator.start();

  const channels = await discoverChannels({
    enabled: secrets.channelsEnabled,
    logger: logger.child({ component: "registry" }),
  });

  const started: Channel[] = [];
  for (const channel of channels) {
    const childLogger = logger.child({ channel: channel.name });
    try {
      await channel.start({
        copilot: orchestrator,
        logger: childLogger,
        config: channelConfig(secrets, channel.name),
      });
      started.push(channel);
      childLogger.info("channel started");
    } catch (err) {
      childLogger.error({ err }, "channel failed to start");
      throw err;
    }
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    for (const channel of started) {
      try {
        await channel.stop();
      } catch (err) {
        logger.warn({ err, channel: channel.name }, "channel stop failed");
      }
    }
    try {
      await orchestrator.stop();
    } catch (err) {
      logger.warn({ err }, "orchestrator stop failed");
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
