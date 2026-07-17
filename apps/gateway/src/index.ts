import { createServer } from "node:http";
import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { decrypt, requireKey } from "../../../packages/core/src/crypto.ts";
import { connectDatabase } from "../../../packages/core/src/db.ts";
import { migrate } from "../../../packages/core/src/migrations.ts";
import { Store } from "../../../packages/core/src/store.ts";

const db = connectDatabase();
await migrate(db);
const store = new Store(db);
const encryptionKey = requireKey(
  process.env.OPENTENTACLES_ENCRYPTION_KEY,
  "OPENTENTACLES_ENCRYPTION_KEY",
);
const health = createServer((request, response) => {
  response.writeHead(request.url === "/health" ? 200 : 404, {
    "content-type": "application/json",
  });
  response.end(
    request.url === "/health" ? '{"ok":true}' : '{"error":"not found"}',
  );
});
health.listen(Number(process.env.PORT ?? 3001));

type GatewayConfig = { token: string; ownerId: string };

async function configuration(): Promise<GatewayConfig> {
  const rows = await db<
    { ciphertext: string | null; owner_id: string | null }[]
  >`
    SELECT (SELECT ciphertext FROM secrets WHERE key='discord_token') AS ciphertext,
      (SELECT value #>> '{}' FROM settings WHERE key='discord_owner_id') AS owner_id`;
  const row = rows[0];
  if (!row?.ciphertext || !row.owner_id)
    throw new Error("Discord gateway is not configured");
  return {
    token: decrypt(row.ciphertext, encryptionKey),
    ownerId: row.owner_id,
  };
}

let client: Client | undefined;
let configurationFingerprint = "";

async function startGateway(config: GatewayConfig): Promise<void> {
  if (client) await client.destroy();
  client = new Client({
    intents: [
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });
  client.once(Events.ClientReady, () =>
    console.log(JSON.stringify({ level: "info", event: "discord.ready" })),
  );
  client.on(Events.MessageCreate, (message) => {
    if (
      message.author.bot ||
      message.guildId ||
      message.author.id !== config.ownerId
    )
      return;
    void message.channel.sendTyping();
    void receive(
      config.ownerId,
      message.channelId,
      message.id,
      message.content,
    );
  });
  await client.login(config.token);
}

async function receive(
  ownerId: string,
  channelId: string,
  externalId: string,
  content: string,
): Promise<void> {
  const input = content.trim();
  if (!input) return;
  if (input.startsWith("/new ")) {
    const [repository, branch, model] = input.slice(5).trim().split(/\s+/);
    const [owner, repo] = repository?.split("/") ?? [];
    if (!owner || !repo)
      return queue(
        channelId,
        externalId,
        "Usage: /new owner/repo [branch] [model]",
      );
    const session = await store.createSession({
      owner,
      repo,
      branch,
      model,
      source: "discord",
      externalId: channelId,
    });
    return queue(
      channelId,
      externalId,
      `Created session ${session.id}. It is provisioning in GitHub Copilot cloud.`,
    );
  }
  if (input === "/sessions") {
    const sessions = await db<
      {
        id: string;
        status: string;
        repository_owner: string;
        repository_name: string;
      }[]
    >`
      SELECT s.id,s.status,s.repository_owner,s.repository_name FROM agent_sessions s
      JOIN conversations c ON c.id=s.conversation_id WHERE c.external_id=${channelId} ORDER BY s.created_at DESC LIMIT 10`;
    return queue(
      channelId,
      externalId,
      sessions.length
        ? sessions
            .map(
              (s) =>
                `${s.id} ${s.status} ${s.repository_owner}/${s.repository_name}`,
            )
            .join("\n")
        : "No sessions. Use /new owner/repo.",
    );
  }
  if (input.startsWith("/resume ")) {
    const id = input.slice(8).trim();
    await enqueueControl(id, "resume");
    return queue(channelId, externalId, `Resume queued for ${id}.`);
  }
  if (input.startsWith("/approve ") || input.startsWith("/deny ")) {
    const approvalId = input.slice(input.indexOf(" ") + 1).trim();
    await store.resolveApproval(
      approvalId,
      input.startsWith("/approve ") ? "approved" : "rejected",
    );
    return queue(channelId, externalId, `Approval ${approvalId} resolved.`);
  }
  if (input.startsWith("/status ")) {
    const id = input.slice(8).trim();
    const session = await store.getSession(id);
    return queue(
      channelId,
      externalId,
      session
        ? `${session.status}${session.mission_control_url ? `\n${session.mission_control_url}` : ""}`
        : "Session not found.",
    );
  }
  if (input.startsWith("/stop ")) {
    const id = input.slice(6).trim();
    await enqueueControl(id, "stop");
    return queue(channelId, externalId, `Stop queued for ${id}.`);
  }
  const rows = await db<{ id: string }[]>`
    SELECT s.id FROM agent_sessions s JOIN conversations c ON c.id=s.conversation_id
    WHERE c.external_id=${channelId} AND s.status IN ('ready','working') ORDER BY s.updated_at DESC LIMIT 1`;
  const session = rows[0];
  if (!session)
    return queue(
      channelId,
      externalId,
      "Create or resume a session first: /new owner/repo",
    );
  await store.enqueuePrompt(session.id, input, externalId);
  await store.audit("discord.prompt", { ownerId, sessionId: session.id });
}

async function enqueueControl(
  id: string,
  kind: "resume" | "stop",
): Promise<void> {
  const session = await store.getSession(id);
  if (!session) throw new Error("session not found");
  await db`INSERT INTO jobs(id,agent_session_id,kind) VALUES (${crypto.randomUUID()},${id},${kind})`;
}

async function queue(
  channelId: string,
  replyToId: string,
  content: string,
): Promise<void> {
  await db`INSERT INTO deliveries(id,channel_id,reply_to_id,content) VALUES (${crypto.randomUUID()},${channelId},${replyToId},${content})`;
}

async function deliver(): Promise<void> {
  if (!client) return;
  const rows = await db<
    {
      id: string;
      channel_id: string;
      reply_to_id: string | null;
      content: string;
      attempts: number;
    }[]
  >`
    WITH next AS (
      SELECT id FROM deliveries WHERE status='queued' OR (status='claimed' AND lease_until < now())
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 5
    ) UPDATE deliveries SET status='claimed', attempts=attempts+1, lease_until=now() + interval '1 minute'
    WHERE id IN (SELECT id FROM next) RETURNING id,channel_id,reply_to_id,content,attempts`;
  for (const delivery of rows) {
    try {
      const channel = await client.channels.fetch(delivery.channel_id);
      if (!channel?.isSendable())
        throw new Error("Discord channel is unavailable");
      for (const chunk of split(delivery.content))
        await channel.send({
          content: chunk,
          reply: delivery.reply_to_id
            ? { messageReference: delivery.reply_to_id }
            : undefined,
        });
      await db`UPDATE deliveries SET status='sent', sent_at=now(), lease_until=null WHERE id=${delivery.id}`;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "delivery failed";
      await db`UPDATE deliveries SET status=${delivery.attempts < 3 ? "queued" : "failed"}, error=${message}, lease_until=null WHERE id=${delivery.id}`;
    }
  }
}

function split(content: string): string[] {
  if (content.length <= 2000) return [content];
  const chunks: string[] = [];
  let remaining = content;
  while (remaining.length > 2000) {
    const cut = Math.max(
      remaining.lastIndexOf("\n", 2000),
      remaining.lastIndexOf(" ", 2000),
      2000,
    );
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  return [...chunks, remaining];
}

setInterval(() => void deliver(), 1_000);
setInterval(() => {
  void configuration()
    .then((config) => {
      const fingerprint = `${config.ownerId}:${config.token}`;
      if (fingerprint !== configurationFingerprint) {
        configurationFingerprint = fingerprint;
        return startGateway(config);
      }
    })
    .catch((error) =>
      console.error(
        JSON.stringify({
          level: "warn",
          event: "discord.configuration",
          message:
            error instanceof Error ? error.message : "configuration error",
        }),
      ),
    );
}, 15_000);
void configuration()
  .then((config) => {
    configurationFingerprint = `${config.ownerId}:${config.token}`;
    return startGateway(config);
  })
  .catch((error) =>
    console.error(
      JSON.stringify({
        level: "warn",
        event: "discord.configuration",
        message: error instanceof Error ? error.message : "configuration error",
      }),
    ),
  );

const shutdown = async () => {
  health.close();
  await client?.destroy();
  await db.end();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
