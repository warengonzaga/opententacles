import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { approveAll, CopilotClient } from "@github/copilot-sdk";
import { channelConfig, loadConfig, resolveRegisteredUser, type AppConfig, type AppSecrets } from "./core/config.ts";
import { CopilotOrchestrator, type CopilotClientLike } from "./core/copilot.ts";
import { openDb } from "./core/db.ts";
import { resolveGhToken } from "./core/gh.ts";
import { createLogger } from "./core/logger.ts";
import { MemoryStore } from "./core/memory.ts";
import { resolveDataDir, resolveWorkspaceDir } from "./core/paths.ts";
import type { Channel, ScopedCopilot } from "./core/types.ts";
import { discoverChannels } from "./registry.ts";

function buildSystemMessage(workspaceDir: string, owners: string[]): string {
  const ownerList = owners.length > 0 ? owners.map((o) => `"${o}"`).join(", ") : "(none configured)";
  return [
    "You are running inside Open Tentacles — a framework that exposes GitHub Copilot through chat apps.",
    "",
    `Your working directory is the workspace root: ${workspaceDir}`,
    "Everything you do (clone, read, edit, run) MUST stay inside that directory.",
    "",
    "Repository layout convention — when you clone a git repo, place it at:",
    `  - ./<owner>/<name>/            if the owner is in this list: ${ownerList}`,
    "  - ./contribution/<owner>/<name>/   otherwise",
    "",
    "Before cloning, check whether the target path already exists and prefer `git fetch` / `git pull` on the existing clone.",
    "Never write files outside the workspace root.",
  ].join("\n");
}

async function main(): Promise<void> {
  let loaded: Awaited<ReturnType<typeof loadConfig>>;
  try {
    loaded = await loadConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
  const { config, secrets, close: closeConfig } = loaded;

  const logger = createLogger({ level: config.log.level, format: config.log.format });
  logger.info(
    { channels: config.channels.enabled, model: config.copilot.model },
    "opententacles starting",
  );

  const workspaceDir = resolveWorkspaceDir();
  mkdirSync(workspaceDir, { recursive: true });
  logger.info({ workspaceDir }, "workspace ready");

  const dataDir = resolveDataDir();
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(join(dataDir, "opententacles.db"));
  const memoryStore = new MemoryStore(db);

  const ghLogger = logger.child({ component: "gh" });
  const ghToken = await resolveGhToken(ghLogger);
  const mcpServers: Record<string, unknown> = {};
  if (ghToken) {
    mcpServers.github = {
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: `Bearer ${ghToken}` },
      tools: ["*"],
    };
    logger.info("GitHub MCP enabled via gh CLI token");
  } else {
    logger.warn(
      "GitHub MCP disabled — install GitHub CLI and run `gh auth login`",
    );
  }

  const systemMessage = buildSystemMessage(workspaceDir, config.github.namespaces);

  const client = new CopilotClient() as unknown as CopilotClientLike;
  const orchestrator = new CopilotOrchestrator({
    client,
    model: config.copilot.model,
    idleTimeoutMs: config.copilot.idleTimeoutMinutes * 60_000,
    permissionHandler: approveAll,
    mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
    workingDirectory: workspaceDir,
    systemMessage,
    memoryStore,
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
    const channelName = channel.name;
    const scopedCopilot: ScopedCopilot = {
      send: (userId, prompt, handler) =>
        orchestrator.send(`${channelName}:${userId}`, prompt, handler),
      setPermissionHandlerFactory: (factory) =>
        orchestrator.setPermissionHandlerFactory(channelName, factory),
    };
    try {
      await channel.start({
        copilot: scopedCopilot,
        logger: childLogger,
        config: channelConfig(config, secrets, channelName),
        registeredUserId: resolveRegisteredUser(config, channelName),
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
    try {
      await closeConfig();
    } catch (err) {
      logger.warn({ err }, "config close failed");
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

export { main as startBot };

// Preserve type re-exports in case other modules import them via this entry.
export type { AppConfig, AppSecrets };
