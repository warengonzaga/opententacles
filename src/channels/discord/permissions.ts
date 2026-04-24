import type { Logger } from "pino";

const PERMISSION_TIMEOUT_MS = 2 * 60_000;

export interface PermissionRequest {
  kind: "shell" | "write" | "mcp" | "read" | "url" | "custom-tool" | string;
  toolCallId?: string;
  [key: string]: unknown;
}

export type PermissionResult =
  | { kind: "approved" }
  | { kind: "denied-interactively-by-user"; feedback?: string };

type PendingEntry = {
  resolve: (result: PermissionResult) => void;
  timer: ReturnType<typeof setTimeout>;
  messageId: string;
  channelId: string;
  userId: string;
};

export interface DiscordRestLike {
  /** POST /channels/:channelId/messages */
  sendMessage(
    channelId: string,
    body: Record<string, unknown>,
  ): Promise<{ id: string }>;
  /** POST /interactions/:id/:token/callback */
  ackInteraction(
    interactionId: string,
    interactionToken: string,
    body: Record<string, unknown>,
  ): Promise<void>;
}

export class DiscordPermissionBroker {
  private readonly pending = new Map<string, PendingEntry>();
  private nonceCounter = 0;

  constructor(
    private readonly rest: DiscordRestLike,
    private readonly logger: Logger,
  ) {}

  /** Returns the DM channel id for a given user, if known. */
  private getUserChannel = (_userId: string): string | null => null;

  setUserChannelResolver(fn: (userId: string) => string | null): void {
    this.getUserChannel = fn;
  }

  makeHandler(userId: string) {
    return async (request: PermissionRequest): Promise<PermissionResult> => {
      const channelId = this.getUserChannel(userId);
      if (!channelId) {
        this.logger.warn(
          { userId, kind: request.kind },
          "permission: no DM channel known for user; denying",
        );
        return { kind: "denied-interactively-by-user", feedback: "no DM channel" };
      }

      const nonce = `${Date.now().toString(36)}${(this.nonceCounter++).toString(36)}`;
      const content = formatRequest(request);
      const components = [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 3,
              label: "Approve",
              custom_id: `ot:approve:${nonce}`,
            },
            {
              type: 2,
              style: 4,
              label: "Deny",
              custom_id: `ot:deny:${nonce}`,
            },
          ],
        },
      ];

      let messageId: string;
      try {
        const sent = await this.rest.sendMessage(channelId, { content, components });
        messageId = sent.id;
      } catch (err) {
        this.logger.error({ err, userId }, "permission: failed to post prompt");
        return { kind: "denied-interactively-by-user", feedback: "prompt post failed" };
      }

      this.logger.info(
        { userId, kind: request.kind, nonce, messageId },
        "permission: prompt posted",
      );

      return new Promise<PermissionResult>((resolve) => {
        const timer = setTimeout(() => {
          const entry = this.pending.get(nonce);
          if (!entry) return;
          this.pending.delete(nonce);
          this.logger.warn({ userId, nonce }, "permission: timed out");
          // Edit the message via REST (best-effort) to strip buttons
          this.rest
            .sendMessage(entry.channelId, {
              content: "⏱️ Permission request timed out — denied.",
              message_reference: { message_id: entry.messageId },
            })
            .catch(() => {});
          resolve({
            kind: "denied-interactively-by-user",
            feedback: "user did not respond within 2 minutes",
          });
        }, PERMISSION_TIMEOUT_MS);

        this.pending.set(nonce, {
          resolve,
          timer,
          messageId,
          channelId,
          userId,
        });
      });
    };
  }

  /**
   * Handle a raw INTERACTION_CREATE gateway event. Returns true if it matched a
   * pending permission request.
   */
  async onInteraction(packet: RawInteraction): Promise<boolean> {
    const d = packet.d;
    if (!d) return false;
    // MESSAGE_COMPONENT = 3
    if (d.type !== 3) return false;
    const customId = d.data?.custom_id ?? "";
    if (!customId.startsWith("ot:")) return false;

    const [, action, nonce] = customId.split(":");
    if (!action || !nonce) return false;

    const entry = this.pending.get(nonce);
    if (!entry) {
      // Acknowledge so Discord doesn't show "interaction failed"
      await this.rest
        .ackInteraction(d.id, d.token, {
          type: 7,
          data: { content: "_(this prompt is no longer active)_", components: [] },
        })
        .catch(() => {});
      return true;
    }

    const clickerId = d.user?.id ?? d.member?.user?.id;
    if (clickerId && clickerId !== entry.userId) {
      this.logger.warn(
        { clickerId, userId: entry.userId, nonce },
        "permission: click by non-owner ignored",
      );
      await this.rest
        .ackInteraction(d.id, d.token, {
          type: 4,
          data: { content: "Only the original requester can respond.", flags: 64 },
        })
        .catch(() => {});
      return true;
    }

    clearTimeout(entry.timer);
    this.pending.delete(nonce);

    const approved = action === "approve";
    const label = approved ? "✅ Approved" : "❌ Denied";
    await this.rest
      .ackInteraction(d.id, d.token, {
        type: 7,
        data: { content: `${label} by <@${entry.userId}>`, components: [] },
      })
      .catch((err) => {
        this.logger.warn({ err, nonce }, "permission: failed to ACK interaction");
      });

    this.logger.info({ userId: entry.userId, nonce, approved }, "permission: resolved");
    entry.resolve(
      approved
        ? { kind: "approved" }
        : { kind: "denied-interactively-by-user", feedback: "user denied" },
    );
    return true;
  }

  cancelAll(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve({
        kind: "denied-interactively-by-user",
        feedback: "shutting down",
      });
    }
    this.pending.clear();
  }
}

export interface RawInteraction {
  t?: string;
  d?: {
    type: number;
    id: string;
    token: string;
    data?: { custom_id?: string; component_type?: number };
    user?: { id: string };
    member?: { user: { id: string } };
    message?: { id: string; channel_id: string };
  };
}

function formatRequest(req: PermissionRequest): string {
  const lines: string[] = [`⚠️ **Copilot needs permission** (\`${req.kind}\`)`];
  switch (req.kind) {
    case "shell": {
      const cmd = str(req.command);
      if (cmd) lines.push(`\n\`\`\`\n${trimTo(cmd, 1500)}\n\`\`\``);
      break;
    }
    case "write":
    case "read": {
      const path = str(req.path) ?? str(req.file);
      if (path) lines.push(`\n**Path:** \`${trimTo(path, 200)}\``);
      break;
    }
    case "url": {
      const url = str(req.url);
      if (url) lines.push(`\n**URL:** ${trimTo(url, 500)}`);
      break;
    }
    case "mcp": {
      const server = str(req.serverName) ?? str(req.server);
      const tool = str(req.toolName) ?? str(req.tool);
      if (server || tool) lines.push(`\n**Tool:** \`${server ?? "?"} / ${tool ?? "?"}\``);
      if (req.args !== undefined) {
        const json = safeJson(req.args);
        if (json) lines.push(`\n\`\`\`json\n${trimTo(json, 1200)}\n\`\`\``);
      }
      break;
    }
    case "custom-tool": {
      const tool = str(req.toolName) ?? str(req.tool);
      if (tool) lines.push(`\n**Tool:** \`${tool}\``);
      if (req.args !== undefined) {
        const json = safeJson(req.args);
        if (json) lines.push(`\n\`\`\`json\n${trimTo(json, 1200)}\n\`\`\``);
      }
      break;
    }
  }
  return trimTo(lines.join("\n"), 1900);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function safeJson(v: unknown): string | null {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return null;
  }
}

function trimTo(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
