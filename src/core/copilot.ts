import type { Logger } from "./logger.ts";
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
  private readonly now: () => number;
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private permissionHandlerFactory?: (userKey: string) => unknown;

  constructor(private readonly opts: OrchestratorOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  setPermissionHandlerFactory(factory: (userKey: string) => unknown): void {
    this.permissionHandlerFactory = factory;
  }

  start(): void {
    const interval = Math.max(30_000, Math.floor(this.opts.idleTimeoutMs / 4));
    this.sweeper = setInterval(() => {
      this.evictIdle().catch((err) => this.opts.logger.error({ err }, "idle eviction failed"));
    }, interval);
  }

  async stop(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    const disconnects = [...this.sessions.values()].map((e) => e.session.disconnect());
    await Promise.allSettled(disconnects);
    this.sessions.clear();
    const errors = await this.opts.client.stop();
    if (errors.length > 0) {
      this.opts.logger.warn({ errors }, "copilot client stop returned errors");
    }
  }

  async send(userKey: string, prompt: string, handler: StreamHandler): Promise<void> {
    const entry = await this.getOrCreate(userKey);
    entry.lastActive = this.now();

    const { session } = entry;
    let idleFired = false;

    const offDelta = session.on("assistant.message_delta", (e) => {
      void handler.onDelta(e.data.deltaContent);
    });
    const offIdle = session.on("session.idle", () => {
      if (idleFired) return;
      idleFired = true;
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
        this.opts.logger.warn({ err, userKey: key }, "session disconnect during eviction failed");
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

    const onPermissionRequest =
      this.permissionHandlerFactory?.(userKey) ?? this.opts.permissionHandler;

    const session = await this.opts.client.createSession({
      model: this.opts.model,
      streaming: true,
      onPermissionRequest,
      ...(this.opts.mcpServers ? { mcpServers: this.opts.mcpServers } : {}),
      ...(this.opts.workingDirectory ? { workingDirectory: this.opts.workingDirectory } : {}),
      ...(this.opts.systemMessage ? { systemMessage: this.opts.systemMessage } : {}),
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
