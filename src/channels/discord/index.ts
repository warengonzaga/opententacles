import type { Client, Message } from "discord.js";
import type { Channel, ChannelContext } from "../../core/types.ts";
import {
  createDiscordClient,
  DiscordChannelConfig,
  Events,
  isEligibleDm,
  type DmMessage,
} from "./client.ts";
import { DiscordStreamBuffer, type EditableMessage } from "./stream.ts";

const TYPING_INTERVAL_MS = 9_000;

class DiscordChannel implements Channel {
  readonly name = "discord";
  private client: Client | null = null;
  private typingTimers = new Map<string, ReturnType<typeof setInterval>>();

  async start(ctx: ChannelContext): Promise<void> {
    const cfg = DiscordChannelConfig.parse(ctx.config ?? {});
    const client = createDiscordClient({ token: cfg.botToken });
    this.client = client;

    client.once(Events.ClientReady, (c) => {
      ctx.logger.info({ user: c.user.tag }, "discord: ready");
    });

    client.on(Events.MessageCreate, async (raw) => {
      if (!client.user) return;
      const message = raw as DmMessage;
      if (!isEligibleDm(message, client.user.id, cfg.allowlist)) {
        if (message.guildId === null && !message.author.bot) {
          ctx.logger.info(
            { userId: message.author.id, tag: message.author.tag },
            "discord: rejected DM (not on allowlist)",
          );
        }
        return;
      }
      try {
        await this.handleDm(ctx, message);
      } catch (err) {
        ctx.logger.error({ err }, "discord: handler crashed");
      }
    });

    await client.login(cfg.botToken);
  }

  async stop(): Promise<void> {
    for (const t of this.typingTimers.values()) clearInterval(t);
    this.typingTimers.clear();
    if (this.client) {
      await this.client.destroy();
      this.client = null;
    }
  }

  private async handleDm(ctx: ChannelContext, message: DmMessage): Promise<void> {
    const content = message.content.trim();
    if (!content) return;

    const startTyping = () => {
      const channel = message.channel;
      if (!channel.isSendable()) return;
      channel.sendTyping().catch(() => {});
      const timer = setInterval(() => {
        channel.sendTyping().catch(() => {});
      }, TYPING_INTERVAL_MS);
      this.typingTimers.set(message.id, timer);
    };
    const stopTyping = () => {
      const t = this.typingTimers.get(message.id);
      if (t) {
        clearInterval(t);
        this.typingTimers.delete(message.id);
      }
    };

    startTyping();
    const placeholder = (await message.reply("…")) as unknown as Message;
    const editable: EditableMessage = {
      edit: (c) => placeholder.edit(c.length === 0 ? "…" : c),
    };
    const buffer = new DiscordStreamBuffer(editable, {
      reply: async (c) => {
        const next = (await message.reply(c)) as unknown as Message;
        return { edit: (nc) => next.edit(nc.length === 0 ? "…" : nc) };
      },
    });

    await ctx.copilot.send(message.author.id, content, {
      onDelta: (chunk) => buffer.append(chunk),
      onIdle: async () => {
        await buffer.finalize();
        stopTyping();
      },
      onError: async (err) => {
        ctx.logger.error({ err }, "discord: copilot send failed");
        await buffer.append("\n\n_(error: Copilot request failed)_");
        await buffer.finalize();
        stopTyping();
      },
    });
  }
}

const channel: Channel = new DiscordChannel();
export default channel;
