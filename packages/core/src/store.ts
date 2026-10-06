import { randomUUID } from "node:crypto";
import type { Database } from "./db.ts";

export type AgentSession = {
  id: string;
  copilot_session_id: string | null;
  repository_owner: string;
  repository_name: string;
  branch: string | null;
  model: string | null;
  status: string;
  mission_control_url: string | null;
};

export class Store {
  constructor(readonly db: Database) {}

  async audit(
    action: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    await this
      .db`INSERT INTO audit_log(action, detail) VALUES (${action}, ${JSON.stringify(detail)}::jsonb)`;
  }

  async paused(): Promise<boolean> {
    const rows = await this.db<
      { value: boolean }[]
    >`SELECT value FROM settings WHERE key = 'paused'`;
    return rows[0]?.value === true;
  }

  async addEvent(
    agentSessionId: string,
    type: string,
    payload: unknown,
  ): Promise<number> {
    const rows = await this.db<
      { id: number }[]
    >`INSERT INTO session_events(agent_session_id,type,payload) VALUES (${agentSessionId},${type},${JSON.stringify(payload)}::jsonb) RETURNING id`;
    return rows[0]?.id ?? 0;
  }

  async events(agentSessionId: string, after = 0) {
    return this
      .db`SELECT id,type,payload,created_at FROM session_events WHERE agent_session_id = ${agentSessionId} AND id > ${after} ORDER BY id`;
  }

  async getSession(id: string): Promise<AgentSession | null> {
    const rows = await this.db<
      AgentSession[]
    >`SELECT id,copilot_session_id,repository_owner,repository_name,branch,model,status,mission_control_url FROM agent_sessions WHERE id = ${id}`;
    return rows[0] ?? null;
  }

  async createSession(input: {
    owner: string;
    repo: string;
    branch?: string;
    model?: string;
    source: "web" | "discord";
    externalId?: string;
    title?: string;
  }): Promise<AgentSession> {
    const conversationId = randomUUID();
    const id = randomUUID();
    await this.db.begin(async (sql) => {
      await sql`INSERT INTO conversations(id,source,external_id,title) VALUES (${conversationId},${input.source},${input.externalId ?? null},${input.title ?? `${input.owner}/${input.repo}`})`;
      await sql`INSERT INTO agent_sessions(id,conversation_id,repository_owner,repository_name,branch,model,status) VALUES (${id},${conversationId},${input.owner},${input.repo},${input.branch ?? null},${input.model ?? null},'creating')`;
      await sql`INSERT INTO jobs(id,agent_session_id,kind) VALUES (${randomUUID()},${id},'create')`;
    });
    const session = await this.getSession(id);
    if (!session) throw new Error("session was not created");
    return session;
  }

  async enqueuePrompt(
    agentSessionId: string,
    prompt: string,
    externalId?: string,
  ): Promise<void> {
    await this.db.begin(async (sql) => {
      const rows = await sql<
        { conversation_id: string; sequence: number }[]
      >`SELECT conversation_id, COALESCE((SELECT max(sequence) FROM messages WHERE conversation_id = agent_sessions.conversation_id),0) + 1 AS sequence FROM agent_sessions WHERE id = ${agentSessionId} FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new Error("unknown session");
      const inserted =
        await sql`INSERT INTO messages(id,conversation_id,sequence,role,content,external_id) VALUES (${randomUUID()},${row.conversation_id},${row.sequence},'user',${prompt},${externalId ?? null}) ON CONFLICT (external_id) DO NOTHING RETURNING id`;
      if (!inserted.length) return;
      await sql`INSERT INTO jobs(id,agent_session_id,kind,payload) VALUES (${randomUUID()},${agentSessionId},'prompt',${sql.json({ prompt })})`;
    });
  }

  async setRemoteSession(
    id: string,
    copilotId: string,
    url: string | null,
    status: string,
  ): Promise<void> {
    await this
      .db`UPDATE agent_sessions SET copilot_session_id=${copilotId}, mission_control_url=${url}, status=${status}, updated_at=now() WHERE id=${id}`;
  }

  async setSessionStatus(id: string, status: string): Promise<void> {
    await this
      .db`UPDATE agent_sessions SET status=${status}, updated_at=now() WHERE id=${id}`;
  }

  async appendAssistant(
    agentSessionId: string,
    content: string,
  ): Promise<void> {
    await this.db.begin(async (sql) => {
      const rows = await sql<
        {
          conversation_id: string;
          sequence: number;
          source: string;
          external_id: string | null;
        }[]
      >`SELECT c.id AS conversation_id,c.source,c.external_id,COALESCE((SELECT max(sequence) FROM messages WHERE conversation_id = c.id),0) + 1 AS sequence FROM agent_sessions JOIN conversations c ON c.id=agent_sessions.conversation_id WHERE agent_sessions.id = ${agentSessionId} FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new Error("unknown session");
      await sql`INSERT INTO messages(id,conversation_id,sequence,role,content) VALUES (${randomUUID()},${row.conversation_id},${row.sequence},'assistant',${content})`;
      if (row.source === "discord" && row.external_id) {
        await sql`INSERT INTO deliveries(id,channel_id,content) VALUES (${randomUUID()},${row.external_id},${content})`;
      }
    });
  }

  async createApproval(
    agentSessionId: string,
    request: unknown,
    seconds: number,
  ): Promise<string> {
    const id = randomUUID();
    await this
      .db`INSERT INTO approvals(id,agent_session_id,request,expires_at) VALUES (${id},${agentSessionId},${JSON.stringify(request)}::jsonb,now() + (${seconds} * interval '1 second'))`;
    return id;
  }

  async approval(id: string): Promise<string | null> {
    const rows = await this.db<
      { status: string }[]
    >`SELECT status FROM approvals WHERE id=${id}`;
    return rows[0]?.status ?? null;
  }

  async resolveApproval(
    id: string,
    status: "approved" | "rejected",
  ): Promise<void> {
    await this
      .db`UPDATE approvals SET status=${status}, resolved_at=now() WHERE id=${id} AND status='pending'`;
  }
}
