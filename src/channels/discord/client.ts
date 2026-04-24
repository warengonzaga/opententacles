import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  type OmitPartialGroupDMChannel,
} from "discord.js";
import { z } from "zod";

export const DiscordChannelConfig = z.object({
  botToken: z.string().min(1, "discord.botToken not set. Run `bun run setup`."),
  allowlist: z.array(z.string()).default([]),
});
export type DiscordChannelConfigT = z.infer<typeof DiscordChannelConfig>;

export interface DiscordClientOptions {
  token: string;
}

export function createDiscordClient(_opts: DiscordClientOptions): Client {
  return new Client({
    intents: [
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });
}

export type DmMessage = OmitPartialGroupDMChannel<Message>;

export function isEligibleDm(
  message: DmMessage,
  botUserId: string,
  allowlist: readonly string[],
): boolean {
  if (message.author.bot) return false;
  if (message.author.id === botUserId) return false;
  if (message.guildId !== null) return false;
  if (allowlist.length > 0 && !allowlist.includes(message.author.id)) return false;
  return true;
}

export { Events };
