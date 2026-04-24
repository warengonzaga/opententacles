import { approveAll, CopilotClient } from "@github/copilot-sdk";
import { channelConfig, loadConfig, loadEnv } from "./core/config.ts";
import { CopilotOrchestrator, type CopilotClientLike } from "./core/copilot.ts";
import { openDb } from "./core/db.ts";
import { createLogger } from "./core/logger.ts";
import type { Channel } from "./core/types.ts";
import { discoverChannels } from "./registry.ts";

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.logLevel);

  if (!env.copilotGithubToken) {
    logger.error("COPILOT_GITHUB_TOKEN is not set. See .env.example.");
    process.exit(1);
  }

  const config = await loadConfig(env.configPath);
  logger.info(
    { channels: config.channels.enabled, model: config.copilot.model },
    "opententacles starting",
  );

  openDb();

  const client = new CopilotClient() as unknown as CopilotClientLike;
  const orchestrator = new CopilotOrchestrator({
    client,
    model: config.copilot.model,
    idleTimeoutMs: config.copilot.idle_timeout_minutes * 60_000,
    permissionHandler: approveAll,
    logger: logger.child({ component: "copilot" }),
  });
  orchestrator.start();

  const channels = await discoverChannels({
    enabled: config.channels.enabled,
    logger: logger.child({ component: "registry" }),
  });

  const started: Channel[] = [];
  for (const channel of channels) {
    const childLogger = logger.child({ channel: channel.name });
    try {
      await channel.start({
        copilot: orchestrator,
        logger: childLogger,
        config: channelConfig(config, channel.name),
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
