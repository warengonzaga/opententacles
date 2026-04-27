import type { Logger } from "./logger.ts";
import type { MemoryStore } from "./memory.ts";
import type { StreamHandler } from "./types.ts";

export interface CopilotSessionLike {
  on(
    event: "assistant.message_delta",
    handler: (e: { data: { deltaContent: string } }) => void,
  ): () => void;
  on(event: "session.idle", handler: () => void): () => void;
  sendAndWait(options: { prompt: string }, timeout?: number): Promise<unknown>;
  disconnect(): Promise<void>;
}

export interface CopilotClientLike {
  createSession(config: {
    model?: string;
    streaming?: boolean;
    onPermissionRequest: unknown;
    mcpServers?: Record<string, unknown>;
    workingDirectory?: string;
    systemMessage?: string;
  }): Promise<CopilotSessionLike>;
  stop(): Promise<Error[]>;
}

export interface OrchestratorOptions {
  client: CopilotClientLike;
  model: string;
  idleTimeoutMs: number;
  sendTimeoutMs?: number;
  permissionHandler: unknown;
  mcpServers?: Record<string, unknown>;
  workingDirectory?: string;
  systemMessage?: string;
  memoryStore?: MemoryStore;
  logger: Logger;
  now?: () => number;
}

interface CachedEntry {
  session: CopilotSessionLike;
  lastActive: number;
  inFlight: Promise<void> | null;
}

export class CopilotOrchestrator {
  private readonly sessions = new Map<string, CachedEntry>();
  private readonly channelFactories = new Map<
    string,
    (userId: string) => unknown
  >();
  private readonly now: () => number;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: OrchestratorOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  setPermissionHandlerFactory(
    channelPrefix: string,
    factory: (userId: string) => unknown,
  ): void {
    this.channelFactories.set(channelPrefix, factory);
  }

  start(): void {
    const interval = Math.max(30_000, Math.floor(this.opts.idleTimeoutMs / 4));
    this.sweeper = setInterval(() => {
      this.evictIdle().catch((err) =>
        this.opts.logger.error({ err }, "idle eviction failed"),
      );
    }, interval);
  }

  async stop(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    const disconnects = [...this.sessions.values()].map((e) =>
      e.session.disconnect(),
    );
    await Promise.allSettled(disconnects);
    this.sessions.clear();
    const errors = await this.opts.client.stop();
    if (errors.length > 0) {
      this.opts.logger.warn({ errors }, "copilot client stop returned errors");
    }
  }

  async send(
    userKey: string,
    prompt: string,
    handler: StreamHandler,
  ): Promise<void> {
    const entry = await this.getOrCreate(userKey);
    entry.lastActive = this.now();

    const { session } = entry;
    let idleFired = false;
    let assistantBuffer = "";

    const ownerId = extractOwnerId(userKey);
    const channel = extractChannel(userKey);

    // Record the user's prompt before sending.
    this.opts.memoryStore?.appendTurn(ownerId, channel, "user", prompt);

    const offDelta = session.on("assistant.message_delta", (e) => {
      assistantBuffer += e.data.deltaContent;
      void handler.onDelta(e.data.deltaContent);
    });
    const offIdle = session.on("session.idle", () => {
      if (idleFired) return;
      idleFired = true;
      // Record the complete assistant response once the turn is done.
      if (assistantBuffer) {
        this.opts.memoryStore?.appendTurn(
          ownerId,
          channel,
          "assistant",
          assistantBuffer,
        );
      }
      void handler.onIdle();
    });

    const task = (async () => {
      try {
        await session.sendAndWait({ prompt }, this.opts.sendTimeoutMs);
      } catch (err) {
        await handler.onError(err);
      } finally {
        offDelta();
        offIdle();
        // If session.idle never fired (e.g., sendAndWait threw), persist any
        // partial assistant response so the user turn is not left dangling.
        if (!idleFired && assistantBuffer) {
          this.opts.memoryStore?.appendTurn(
            ownerId,
            channel,
            "assistant",
            assistantBuffer,
          );
        }
        entry.lastActive = this.now();
        entry.inFlight = null;
      }
    })();

    entry.inFlight = task;
    await task;
  }

  async evictIdle(): Promise<void> {
    const cutoff = this.now() - this.opts.idleTimeoutMs;
    const stale: Array<[string, CachedEntry]> = [];
    for (const [key, entry] of this.sessions) {
      if (entry.inFlight) continue;
      if (entry.lastActive < cutoff) stale.push([key, entry]);
    }
    for (const [key, entry] of stale) {
      this.sessions.delete(key);
      try {
        await entry.session.disconnect();
      } catch (err) {
        this.opts.logger.warn(
          { err, userKey: key },
          "session disconnect during eviction failed",
        );
      }
      this.opts.logger.debug({ userKey: key }, "evicted idle session");
    }
  }

  size(): number {
    return this.sessions.size;
  }

  has(userKey: string): boolean {
    return this.sessions.has(userKey);
  }

  private async getOrCreate(userKey: string): Promise<CachedEntry> {
    const existing = this.sessions.get(userKey);
    if (existing) return existing;

    const channelFactory = this.channelFactories.get(extractChannel(userKey));
    const onPermissionRequest =
      channelFactory?.(extractOwnerId(userKey)) ?? this.opts.permissionHandler;

    // Inject cross-channel history on cold start.
    let sessionSystemMessage = this.opts.systemMessage;
    if (this.opts.memoryStore) {
      const ownerId = extractOwnerId(userKey);
      const turns = this.opts.memoryStore.loadRecent(ownerId);
      const historyBlock = this.opts.memoryStore.formatForInjection(turns);
      if (historyBlock) {
        // History goes before the core system instructions so model constraints take precedence.
        sessionSystemMessage = sessionSystemMessage
          ? `${historyBlock}\n\n${sessionSystemMessage}`
          : historyBlock;
      }
    }

    const session = await this.opts.client.createSession({
      model: this.opts.model,
      streaming: true,
      onPermissionRequest,
      ...(this.opts.mcpServers ? { mcpServers: this.opts.mcpServers } : {}),
      ...(this.opts.workingDirectory
        ? { workingDirectory: this.opts.workingDirectory }
        : {}),
      ...(sessionSystemMessage ? { systemMessage: sessionSystemMessage } : {}),
    });
    const entry: CachedEntry = {
      session,
      lastActive: this.now(),
      inFlight: null,
    };
    this.sessions.set(userKey, entry);
    this.opts.logger.debug({ userKey }, "created new Copilot session");
    return entry;
  }
}

/** Strips the channel prefix from a namespaced userKey (e.g. "discord:123" → "123"). */
function extractOwnerId(userKey: string): string {
  const idx = userKey.indexOf(":");
  return idx >= 0 ? userKey.slice(idx + 1) : userKey;
}

/** Returns the channel portion of a namespaced userKey (e.g. "discord:123" → "discord"). */
function extractChannel(userKey: string): string {
  const idx = userKey.indexOf(":");
  return idx >= 0 ? userKey.slice(0, idx) : "default";
}
