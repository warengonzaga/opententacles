import type { Client } from "discord.js";
import type { Channel, ChannelContext } from "../../core/types.ts";
import {
  createDiscordClient,
  DiscordChannelConfig,
  Events,
} from "./client.ts";
import {
  DiscordPermissionBroker,
  type DiscordRestLike,
  type RawInteraction,
} from "./permissions.ts";

const TYPING_INTERVAL_MS = 9_000;
const DISCORD_MAX_LEN = 2000;

interface RawMessageCreate {
  t?: string;
  d?: {
    id: string;
    channel_id: string;
    guild_id?: string | null;
    content: string;
    author: {
      id: string;
      username: string;
      bot?: boolean;
    };
  };
}

interface RestMessage {
  id: string;
}

class DiscordChannel implements Channel {
  readonly name = "discord";
  private client: Client | null = null;
  private typingTimers = new Map<string, ReturnType<typeof setInterval>>();
  private userDmChannels = new Map<string, string>();
  private broker: DiscordPermissionBroker | null = null;

  async start(ctx: ChannelContext): Promise<void> {
    const cfg = DiscordChannelConfig.parse(ctx.config ?? {});
    const client = createDiscordClient({ token: cfg.botToken });
    this.client = client;

    const rest = createDiscordRest(cfg.botToken);
    const broker = new DiscordPermissionBroker(rest, ctx.logger.child({ sub: "permissions" }));
    broker.setUserChannelResolver((userId) => this.userDmChannels.get(userId) ?? null);
    this.broker = broker;

    ctx.copilot.setPermissionHandlerFactory((userKey) => broker.makeHandler(userKey));

    client.once(Events.ClientReady, (c) => {
      ctx.logger.info({ user: c.user.tag }, "discord: ready");
    });

    client.on(Events.Error, (err) => {
      ctx.logger.error({ err }, "discord: client error");
    });

    client.on(Events.ShardError, (err, shardId) => {
      ctx.logger.error({ err, shardId }, "discord: shard error");
    });

    client.on(Events.Raw, (packet: unknown) => {
      const p = packet as { t?: string };
      if (p.t === "INTERACTION_CREATE") {
        broker.onInteraction(packet as RawInteraction).catch((err) => {
          ctx.logger.error({ err }, "discord: interaction handler crashed");
        });
        return;
      }
      if (p.t !== "MESSAGE_CREATE") return;
      const mp = packet as RawMessageCreate;
      if (!mp.d) return;
      const d = mp.d;
      if (!client.user) return;

      // Only DMs (no guild_id)
      if (d.guild_id) return;
      // Ignore bots and self
      if (d.author.bot) return;
      if (d.author.id === client.user.id) return;
      // Allowlist
      if (cfg.allowlist.length > 0 && !cfg.allowlist.includes(d.author.id)) {
        ctx.logger.info(
          { userId: d.author.id, tag: d.author.username },
          "discord: rejected DM (not on allowlist)",
        );
        return;
      }

      ctx.logger.info(
        { authorId: d.author.id, channelId: d.channel_id, hasContent: !!d.content },
        "discord: DM received",
      );

      this.userDmChannels.set(d.author.id, d.channel_id);

      this.handleRawDm(ctx, d, rest).catch((err) => {
        ctx.logger.error({ err }, "discord: handler crashed");
      });
    });

    await client.login(cfg.botToken);
  }

  async stop(): Promise<void> {
    for (const t of this.typingTimers.values()) clearInterval(t);
    this.typingTimers.clear();
    if (this.broker) {
      this.broker.cancelAll();
      this.broker = null;
    }
    if (this.client) {
      await this.client.destroy();
      this.client = null;
    }
  }

  private async handleRawDm(
    ctx: ChannelContext,
    d: NonNullable<RawMessageCreate["d"]>,
    rest: DiscordRestLike & { sendTyping(channelId: string): Promise<void> },
  ): Promise<void> {
    const content = d.content.trim();
    if (!content) {
      ctx.logger.debug({ authorId: d.author.id }, "discord: ignoring message with no text content");
      return;
    }

    const channelId = d.channel_id;

    const sendTyping = () => rest.sendTyping(channelId).catch(() => {});

    void sendTyping();
    const typingTimer = setInterval(() => void sendTyping(), TYPING_INTERVAL_MS);
    this.typingTimers.set(d.id, typingTimer);
    const stopTyping = () => {
      const t = this.typingTimers.get(d.id);
      if (t) {
        clearInterval(t);
        this.typingTimers.delete(d.id);
      }
    };

    let full = "";
    let replyToId: string | undefined = d.id;
    let sending: Promise<void> = Promise.resolve();

    const flushFullResponse = async (): Promise<void> => {
      const text = full.trim();
      if (!text) return;
      const chunks = splitForDiscord(text, DISCORD_MAX_LEN);
      for (const chunk of chunks) {
        const body: Record<string, unknown> = { content: chunk };
        if (replyToId) body.message_reference = { message_id: replyToId };
        await rest.sendMessage(channelId, body);
        replyToId = undefined;
      }
    };

    await ctx.copilot.send(d.author.id, content, {
      onDelta: (chunk) => {
        full += chunk;
      },
      onIdle: async () => {
        stopTyping();
        sending = sending.then(flushFullResponse);
        await sending;
      },
      onError: async (err) => {
        ctx.logger.error({ err }, "discord: copilot send failed");
        stopTyping();
        await rest
          .sendMessage(channelId, {
            content: "_(error: Copilot request failed)_",
            ...(replyToId ? { message_reference: { message_id: replyToId } } : {}),
          })
          .catch(() => {});
      },
    });
  }
}

function createDiscordRest(
  token: string,
): DiscordRestLike & { sendTyping(channelId: string): Promise<void> } {
  const call = async (path: string, init: RequestInit): Promise<Response> => {
    const res = await fetch(`https://discord.com/api/v10${path}`, {
      ...init,
      headers: {
        "Authorization": `Bot ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "OpenTentacles (https://github.com/warengonzaga/opententacles, 0.1.0)",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Discord REST ${init.method ?? "GET"} ${path} ${res.status}: ${body}`);
    }
    return res;
  };

  return {
    sendTyping: async (channelId) => {
      await call(`/channels/${channelId}/typing`, { method: "POST" });
    },
    sendMessage: async (channelId, body) => {
      const res = await call(`/channels/${channelId}/messages`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return (await res.json()) as RestMessage;
    },
    ackInteraction: async (interactionId, interactionToken, body) => {
      await call(`/interactions/${interactionId}/${interactionToken}/callback`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
  };
}

function splitForDiscord(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf("\n", maxLen);
    if (cut < maxLen / 2) cut = remaining.lastIndexOf(" ", maxLen);
    if (cut < maxLen / 2) cut = maxLen;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

const channel: Channel = new DiscordChannel();
export default channel;
