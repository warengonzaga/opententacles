import type { Database } from "./db.ts";

const schema = `
CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS admins (id boolean PRIMARY KEY DEFAULT true CHECK (id), username text UNIQUE NOT NULL, password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS web_sessions (token_hash text PRIMARY KEY, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS secrets (key text PRIMARY KEY, ciphertext text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS conversations (id uuid PRIMARY KEY, source text NOT NULL CHECK (source IN ('web','discord')), external_id text UNIQUE, title text NOT NULL DEFAULT 'New session', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS messages (id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, sequence integer NOT NULL, role text NOT NULL CHECK (role IN ('user','assistant','system','status')), content text NOT NULL, external_id text UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(conversation_id, sequence));
CREATE TABLE IF NOT EXISTS agent_sessions (id uuid PRIMARY KEY, conversation_id uuid NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE, copilot_session_id text UNIQUE, repository_owner text NOT NULL, repository_name text NOT NULL, branch text, model text, status text NOT NULL CHECK (status IN ('creating','ready','working','paused','stopped','failed','policy_blocked')), mission_control_url text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS jobs (id uuid PRIMARY KEY, agent_session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE, kind text NOT NULL CHECK (kind IN ('create','prompt','stop','resume')), payload jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','claimed','done','failed','cancelled')), attempts integer NOT NULL DEFAULT 0, claimed_by text, lease_until timestamptz, error text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz);
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs(status, lease_until, created_at);
CREATE TABLE IF NOT EXISTS session_events (id bigserial PRIMARY KEY, agent_session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE, type text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS session_events_stream_idx ON session_events(agent_session_id, id);
CREATE TABLE IF NOT EXISTS approvals (id uuid PRIMARY KEY, agent_session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE, request jsonb NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')), expires_at timestamptz NOT NULL, resolved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS deliveries (id uuid PRIMARY KEY, channel_id text NOT NULL, reply_to_id text, content text NOT NULL, status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','claimed','sent','failed')), attempts integer NOT NULL DEFAULT 0, claimed_by text, lease_until timestamptz, error text, created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz);
CREATE INDEX IF NOT EXISTS deliveries_claim_idx ON deliveries(status, lease_until, created_at);
CREATE TABLE IF NOT EXISTS mcp_servers (id uuid PRIMARY KEY, name text UNIQUE NOT NULL, transport text NOT NULL CHECK (transport IN ('http','sse')), url text NOT NULL, header_secret_key text REFERENCES secrets(key), enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS tool_policy (category text PRIMARY KEY, decision text NOT NULL CHECK (decision IN ('allow','ask','deny')));
CREATE TABLE IF NOT EXISTS audit_log (id bigserial PRIMARY KEY, action text NOT NULL, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO settings(key,value) VALUES ('paused','false'::jsonb), ('limits','{"concurrency":1,"daily_session_cap":20,"approval_timeout_seconds":300}'::jsonb) ON CONFLICT (key) DO NOTHING;
INSERT INTO tool_policy(category,decision) VALUES ('sandbox','allow'),('github','ask'),('external','ask'),('unknown','deny') ON CONFLICT (category) DO NOTHING;
`;

export async function migrate(db: Database): Promise<void> {
  await db.begin(async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(726841921)`;
    await sql.unsafe(schema);
    await sql`INSERT INTO schema_migrations(version) VALUES (1) ON CONFLICT DO NOTHING`;
  });
}
