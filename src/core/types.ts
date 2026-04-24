import type { Logger } from "pino";
import type { CopilotOrchestrator } from "./copilot.ts";

export interface ChannelContext {
  copilot: CopilotOrchestrator;
  logger: Logger;
  config: unknown;
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
