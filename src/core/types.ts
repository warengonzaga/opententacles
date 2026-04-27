import type { Logger } from "./logger.ts";

/**
 * The channel-scoped Copilot interface exposed to every channel implementation.
 * The framework automatically namespaces userKeys as `<channelName>:<userId>`
 * so sessions are isolated across channels. Channels pass raw user IDs only.
 */
export interface ScopedCopilot {
  send(userId: string, prompt: string, handler: StreamHandler): Promise<void>;
  setPermissionHandlerFactory(factory: (userId: string) => unknown): void;
}

export interface ChannelContext {
  /** Channel-scoped Copilot interface — userKey namespacing is handled by the framework. */
  copilot: ScopedCopilot;
  logger: Logger;
  config: unknown;
  /**
   * The single authorized user ID for this channel, or null if unrestricted.
   * Set by the framework from config. Channels use this for access control.
   */
  registeredUserId: string | null;
}

export interface Channel {
  readonly name: string;
  start(ctx: ChannelContext): Promise<void>;
  stop(): Promise<void>;
}

export type StreamHandler = {
  onDelta(chunk: string): void | Promise<void>;
  onIdle(): void | Promise<void>;
  onError(err: unknown): void | Promise<void>;
};
