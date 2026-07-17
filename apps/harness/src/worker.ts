import type {
  CopilotClient,
  CopilotSession,
  MCPServerConfig,
} from "@github/copilot-sdk";
import { decrypt } from "../../../packages/core/src/crypto.ts";
import type { Database } from "../../../packages/core/src/db.ts";
import { policyForPermission } from "../../../packages/core/src/policy.ts";
import {
  type ClaimedJob,
  claimJob,
  finishJob,
} from "../../../packages/core/src/queue.ts";
import { Store } from "../../../packages/core/src/store.ts";

const READY_TIMEOUT_MS = 60_000;
const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(
      /(?:gh[pousr]_|github_pat_|Bearer\s+)[A-Za-z0-9_=-]+/gi,
      "[REDACTED]",
    );
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /token|secret|authorization|password/i.test(key)
          ? "[REDACTED]"
          : redact(item),
      ]),
    );
  }
  return value;
}

export class HarnessWorker {
  private readonly sessions = new Map<string, CopilotSession>();
  private readonly deltas = new Map<
    string,
    { content: string; savedAt: number }
  >();
  private readonly store: Store;
  private running = false;

  constructor(
    private readonly db: Database,
    private readonly client: CopilotClient,
    private readonly workerId: string,
    private readonly encryptionKey: Buffer,
  ) {
    this.store = new Store(db);
  }

  async run(): Promise<void> {
    this.running = true;
    while (this.running) {
      const job = await claimJob(this.db, this.workerId);
      if (!job) {
        await sleep(500);
        continue;
      }
      await this.handle(job);
    }
  }

  stop(): void {
    this.running = false;
  }

  async handle(job: ClaimedJob): Promise<void> {
    try {
      if ((await this.store.paused()) && job.kind !== "stop") {
        await finishJob(this.db, job.id, "cancelled", "deployment is paused");
        return;
      }
      if (job.kind === "create") await this.create(job);
      if (job.kind === "prompt") await this.prompt(job);
      if (job.kind === "resume") await this.resume(job);
      if (job.kind === "stop") await this.stopSession(job);
      await finishJob(this.db, job.id, "done");
    } catch (error) {
      const redacted = redact(
        error instanceof Error ? error.message : "unknown harness error",
      );
      const message =
        typeof redacted === "string" ? redacted : "unknown harness error";
      const policyBlocked = record(error).reason === "policy_blocked";
      await this.store.setSessionStatus(
        job.agent_session_id,
        policyBlocked ? "policy_blocked" : "failed",
      );
      await this.store.addEvent(job.agent_session_id, "session.error", {
        message,
        policyBlocked,
      });
      await finishJob(this.db, job.id, "failed", message);
    }
  }

  private async create(job: ClaimedJob): Promise<void> {
    const limits = await this.db<
      { value: { concurrency?: number; daily_session_cap?: number } }[]
    >`SELECT value FROM settings WHERE key='limits'`;
    const limit = limits[0]?.value ?? {};
    const daily = await this.db<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM agent_sessions WHERE created_at >= date_trunc('day', now())`;
    const active = await this.db<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM agent_sessions WHERE status = 'working'`;
    if ((daily[0]?.count ?? 0) > (limit.daily_session_cap ?? 20))
      throw new Error("daily session cap reached");
    if ((active[0]?.count ?? 0) >= (limit.concurrency ?? 1))
      throw new Error("session concurrency limit reached");
    const appSession = await this.requireSession(job.agent_session_id);
    let remoteUrl: string | null = null;
    let readyResolve: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });
    const session = await this.client.createSession({
      model: appSession.model ?? undefined,
      streaming: true,
      cloud: {
        repository: {
          owner: appSession.repository_owner,
          name: appSession.repository_name,
          branch: appSession.branch ?? undefined,
        },
      },
      mcpServers: await this.mcpServers(),
      onPermissionRequest: (request) =>
        this.permission(job.agent_session_id, request),
      onEvent: (event) => {
        const eventRecord = record(event);
        const data = record(eventRecord.data);
        if (
          eventRecord.type === "session.start" &&
          data.producer === "copilot-agent"
        )
          readyResolve?.();
        if (eventRecord.type === "session.info" && data.infoType === "remote")
          remoteUrl = text(data.url) ?? null;
        void this.persistEvent(job.agent_session_id, event);
      },
    });
    this.sessions.set(job.agent_session_id, session);
    await this.waitForReady(ready);
    await this.store.setRemoteSession(
      job.agent_session_id,
      session.sessionId,
      remoteUrl,
      "ready",
    );
    await this.store.addEvent(job.agent_session_id, "session.ready", {
      copilotSessionId: session.sessionId,
      missionControlUrl: remoteUrl,
    });
  }

  private async resume(job: ClaimedJob): Promise<void> {
    const appSession = await this.requireSession(job.agent_session_id);
    if (!appSession.copilot_session_id)
      throw new Error("cannot resume without a Copilot session ID");
    const session = await this.client.resumeSession(
      appSession.copilot_session_id,
      {
        onPermissionRequest: (request) =>
          this.permission(job.agent_session_id, request),
        continuePendingWork: false,
        onEvent: (event) => void this.persistEvent(job.agent_session_id, event),
      },
    );
    this.sessions.set(job.agent_session_id, session);
    await this.store.setSessionStatus(job.agent_session_id, "ready");
  }

  private async prompt(job: ClaimedJob): Promise<void> {
    const prompt = text(job.payload.prompt);
    if (!prompt) throw new Error("prompt job has no prompt");
    const session = this.sessions.get(job.agent_session_id);
    if (!session)
      throw new Error(
        "session is not connected; enqueue resume before another prompt",
      );
    await this.store.setSessionStatus(job.agent_session_id, "working");
    const answer = await session.sendAndWait({ prompt }, 30 * 60_000);
    if (answer?.data.content)
      await this.store.appendAssistant(
        job.agent_session_id,
        answer.data.content,
      );
    await this.store.setSessionStatus(job.agent_session_id, "ready");
  }

  private async stopSession(job: ClaimedJob): Promise<void> {
    const session = this.sessions.get(job.agent_session_id);
    if (session) {
      await session.abort();
      await session.disconnect();
      this.sessions.delete(job.agent_session_id);
    }
    await this.store.setSessionStatus(job.agent_session_id, "stopped");
  }

  private async permission(
    agentSessionId: string,
    request: unknown,
  ): Promise<{ kind: "approve-once" } | { kind: "reject"; feedback: string }> {
    const decision = policyForPermission(record(request));
    if (decision === "allow") return { kind: "approve-once" };
    const approvalId = await this.store.createApproval(
      agentSessionId,
      redact(request),
      300,
    );
    await this.store.addEvent(agentSessionId, "approval.pending", {
      approvalId,
    });
    const until = Date.now() + 300_000;
    while (Date.now() < until) {
      const status = await this.store.approval(approvalId);
      if (status === "approved") return { kind: "approve-once" };
      if (status === "rejected" || status === "expired")
        return { kind: "reject", feedback: "approval denied" };
      await sleep(1_000);
    }
    await this
      .db`UPDATE approvals SET status='expired' WHERE id=${approvalId} AND status='pending'`;
    return { kind: "reject", feedback: "approval timed out" };
  }

  private async persistEvent(
    agentSessionId: string,
    event: unknown,
  ): Promise<void> {
    const value = record(event);
    const type = text(value.type) ?? "unknown";
    const payload = redact(record(value.data));
    if (type === "assistant.message_delta") {
      const delta = text(record(payload).deltaContent);
      if (!delta) return;
      const buffered = this.deltas.get(agentSessionId) ?? {
        content: "",
        savedAt: Date.now(),
      };
      buffered.content += delta;
      if (Date.now() - buffered.savedAt < 750) {
        this.deltas.set(agentSessionId, buffered);
        return;
      }
      this.deltas.delete(agentSessionId);
      await this.store.addEvent(agentSessionId, type, {
        deltaContent: buffered.content,
      });
      return;
    }
    const buffered = this.deltas.get(agentSessionId);
    if (buffered?.content) {
      this.deltas.delete(agentSessionId);
      await this.store.addEvent(agentSessionId, "assistant.message_delta", {
        deltaContent: buffered.content,
      });
    }
    await this.store.addEvent(agentSessionId, type, payload);
  }

  private async mcpServers(): Promise<Record<string, MCPServerConfig>> {
    const rows = await this.db<
      {
        name: string;
        transport: "http" | "sse";
        url: string;
        ciphertext: string | null;
      }[]
    >`
      SELECT m.name,m.transport,m.url,s.ciphertext FROM mcp_servers m LEFT JOIN secrets s ON s.key=m.header_secret_key WHERE m.enabled = true`;
    return Object.fromEntries(
      rows.map((row) => {
        const headers = row.ciphertext
          ? (JSON.parse(decrypt(row.ciphertext, this.encryptionKey)) as Record<
              string,
              string
            >)
          : undefined;
        return [row.name, { type: row.transport, url: row.url, headers }];
      }),
    );
  }

  private async requireSession(id: string) {
    const session = await this.store.getSession(id);
    if (!session) throw new Error("unknown agent session");
    return session;
  }

  private async waitForReady(ready: Promise<void>): Promise<void> {
    await Promise.race([
      ready,
      sleep(READY_TIMEOUT_MS).then(() => {
        throw new Error(
          "cloud worker did not emit session.start within 60 seconds",
        );
      }),
    ]);
  }
}
