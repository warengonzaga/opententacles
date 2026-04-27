import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import { z } from "zod";

export const DiscordChannelConfig = z.object({
  botToken: z.string().min(1, "discord.botToken not set. Run `opententacles setup`."),
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
    partials: [Partials.Channel, Partials.Message, Partials.User],
  });
}

export { Events };
