import { resolve } from "node:path";
import type { Logger } from "./core/logger.ts";
import type { Channel } from "./core/types.ts";

export interface DiscoveryOptions {
  enabled: string[];
  channelsDir?: string;
  logger: Logger;
}

export async function discoverChannels(
  opts: DiscoveryOptions,
): Promise<Channel[]> {
  const channelsDir = opts.channelsDir ?? resolve(import.meta.dir, "channels");
  const channels: Channel[] = [];

  for (const name of opts.enabled) {
    const entry = resolve(channelsDir, name, "index.ts");
    const file = Bun.file(entry);
    if (!(await file.exists())) {
      throw new Error(
        `Channel "${name}" is enabled in config but ${entry} does not exist.`,
      );
    }

    const mod = await import(entry);
    const channel = (mod.default ?? mod.channel) as Channel | undefined;
    if (!channel || typeof channel.start !== "function") {
      throw new Error(
        `Channel "${name}" at ${entry} must export a default Channel implementation.`,
      );
    }
    if (channel.name !== name) {
      opts.logger.warn(
        { expected: name, actual: channel.name },
        "channel folder name does not match exported name",
      );
    }
    channels.push(channel);
  }

  return channels;
}
