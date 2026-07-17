import type { Database } from "./db.ts";

export type ClaimedJob = {
  id: string;
  agent_session_id: string;
  kind: "create" | "prompt" | "stop" | "resume";
  payload: Record<string, unknown>;
  attempts: number;
};

export async function claimJob(
  db: Database,
  worker: string,
): Promise<ClaimedJob | null> {
  const rows = await db<ClaimedJob[]>`
    WITH next AS (
      SELECT j.id FROM jobs j
      WHERE (j.status = 'queued' OR (j.status = 'claimed' AND j.lease_until < now() AND j.kind <> 'prompt'))
      AND NOT EXISTS (
        SELECT 1 FROM jobs active WHERE active.agent_session_id = j.agent_session_id
        AND active.status = 'claimed' AND active.lease_until > now()
      )
      ORDER BY j.created_at FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE jobs SET status = 'claimed', claimed_by = ${worker}, attempts = attempts + 1,
      lease_until = now() + interval '2 minutes'
    WHERE id = (SELECT id FROM next)
    RETURNING id, agent_session_id, kind, payload, attempts`;
  return rows[0] ?? null;
}

export async function finishJob(
  db: Database,
  id: string,
  status: "done" | "failed" | "cancelled",
  error?: string,
): Promise<void> {
  await db`UPDATE jobs SET status = ${status}, error = ${error ?? null}, completed_at = now(), lease_until = null WHERE id = ${id}`;
}
