import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { URL } from "node:url";
import { z } from "zod";
import {
  createSessionToken,
  encrypt,
  hashPassword,
  hashSessionToken,
  requireKey,
  verifyPassword,
} from "../../../packages/core/src/crypto.ts";
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
const sessionKey = requireKey(
  process.env.OPENTENTACLES_SESSION_KEY,
  "OPENTENTACLES_SESSION_KEY",
);
const appUrl = new URL(
  process.env.OPENTENTACLES_APP_URL ?? "http://localhost:3000",
);
const attempts = new Map<string, number[]>();

const credentials = z.object({
  username: z.string().regex(/^[a-zA-Z0-9_-]{3,64}$/),
  password: z.string().min(12).max(256),
});
const newSession = z.object({
  owner: z.string().regex(/^[A-Za-z0-9-]+$/),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  branch: z.string().min(1).max(255).optional(),
  model: z.string().min(1).max(255).optional(),
});

function cookies(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    (request.headers.cookie ?? "").split(";").flatMap((pair) => {
      const index = pair.indexOf("=");
      return index === -1
        ? []
        : [
            [
              pair.slice(0, index).trim(),
              decodeURIComponent(pair.slice(index + 1)),
            ],
          ];
    }),
  );
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<unknown> {
  let content = "";
  for await (const chunk of request) {
    content += chunk;
    if (content.length > 1_000_000) throw new Error("request body too large");
  }
  return content ? JSON.parse(content) : {};
}

function requireSameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  return !origin || new URL(origin).origin === appUrl.origin;
}

async function authenticated(request: IncomingMessage): Promise<boolean> {
  const token = cookies(request).ot_session;
  if (!token) return false;
  const hash = hashSessionToken(token, sessionKey);
  const rows = await db<
    { present: boolean }[]
  >`SELECT true AS present FROM web_sessions WHERE token_hash=${hash} AND expires_at > now()`;
  return rows[0]?.present === true;
}

function cookie(token: string): string {
  return `ot_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${appUrl.protocol === "https:" ? "; Secure" : ""}`;
}

function tooManyAttempts(request: IncomingMessage): boolean {
  const ip = request.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const recent = (attempts.get(ip) ?? []).filter(
    (time) => now - time < 15 * 60_000,
  );
  recent.push(now);
  attempts.set(ip, recent);
  return recent.length > 10;
}

async function sessionRows() {
  return db`SELECT s.id,s.repository_owner,s.repository_name,s.branch,s.model,s.status,s.mission_control_url,s.created_at
    FROM agent_sessions s ORDER BY s.updated_at DESC`;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", appUrl);
    if (url.pathname === "/health") return json(response, 200, { ok: true });
    if (url.pathname === "/" && request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return response.end(page());
    }
    if (url.pathname === "/api/setup" && request.method === "POST") {
      if (!requireSameOrigin(request))
        return json(response, 403, { error: "origin denied" });
      const existing = await db<
        { present: boolean }[]
      >`SELECT true AS present FROM admins LIMIT 1`;
      if (existing.length)
        return json(response, 409, { error: "administrator already exists" });
      const input = credentials.parse(await body(request));
      await db`INSERT INTO admins(username,password_hash) VALUES (${input.username},${await hashPassword(input.password)})`;
      await store.audit("admin.setup", { username: input.username });
      return json(response, 201, { ok: true });
    }
    if (url.pathname === "/api/setup" && request.method === "GET") {
      const existing = await db<
        { present: boolean }[]
      >`SELECT true AS present FROM admins LIMIT 1`;
      return json(response, 200, { required: existing.length === 0 });
    }
    if (url.pathname === "/api/login" && request.method === "POST") {
      if (!requireSameOrigin(request))
        return json(response, 403, { error: "origin denied" });
      if (tooManyAttempts(request))
        return json(response, 429, { error: "too many attempts" });
      const input = credentials.parse(await body(request));
      const rows = await db<
        { password_hash: string }[]
      >`SELECT password_hash FROM admins WHERE username=${input.username}`;
      if (
        !rows[0] ||
        !(await verifyPassword(input.password, rows[0].password_hash))
      ) {
        await store.audit("auth.failed", { username: input.username });
        return json(response, 401, { error: "invalid credentials" });
      }
      const token = createSessionToken();
      await db`INSERT INTO web_sessions(token_hash,expires_at) VALUES (${hashSessionToken(token, sessionKey)},now() + interval '7 days')`;
      response.setHeader("set-cookie", cookie(token));
      await store.audit("auth.login", { username: input.username });
      return json(response, 200, { ok: true });
    }
    if (url.pathname === "/api/logout" && request.method === "POST") {
      if (!requireSameOrigin(request))
        return json(response, 403, { error: "origin denied" });
      const token = cookies(request).ot_session;
      if (token)
        await db`DELETE FROM web_sessions WHERE token_hash=${hashSessionToken(token, sessionKey)}`;
      response.setHeader(
        "set-cookie",
        "ot_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
      );
      return json(response, 200, { ok: true });
    }
    if (!(await authenticated(request)))
      return json(response, 401, { error: "authentication required" });
    if (request.method !== "GET" && !requireSameOrigin(request))
      return json(response, 403, { error: "origin denied" });
    if (url.pathname === "/api/sessions" && request.method === "GET")
      return json(response, 200, await sessionRows());
    if (url.pathname === "/api/sessions" && request.method === "POST") {
      const input = newSession.parse(await body(request));
      const session = await store.createSession({ ...input, source: "web" });
      await store.audit("session.create", {
        sessionId: session.id,
        repository: `${input.owner}/${input.repo}`,
      });
      return json(response, 201, session);
    }
    if (url.pathname === "/api/failed-jobs" && request.method === "GET") {
      return json(
        response,
        200,
        await db`SELECT id,agent_session_id,kind,error,created_at FROM jobs WHERE status='failed' ORDER BY created_at DESC LIMIT 100`,
      );
    }
    const sessionMatch = url.pathname.match(
      /^\/api\/sessions\/([0-9a-f-]+)(?:\/(prompt|stop|resume|events))?$/,
    );
    if (sessionMatch) {
      const [, id, action] = sessionMatch;
      if (!id) return json(response, 404, { error: "not found" });
      if (action === "events" && request.method === "GET") {
        const after = Number(
          request.headers["last-event-id"] ??
            url.searchParams.get("after") ??
            0,
        );
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        let last = Number.isFinite(after) ? after : 0;
        const timer = setInterval(() => {
          void store.events(id, last).then((events) => {
            for (const event of events) {
              last = event.id;
              response.write(
                `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`,
              );
            }
          });
        }, 1_000);
        request.once("close", () => clearInterval(timer));
        return;
      }
      if (!action && request.method === "GET") {
        return json(
          response,
          200,
          await db`SELECT m.id,m.role,m.content,m.created_at FROM messages m JOIN agent_sessions s ON s.conversation_id=m.conversation_id WHERE s.id=${id} ORDER BY m.sequence`,
        );
      }
      if (action === "prompt" && request.method === "POST") {
        const input = z
          .object({ prompt: z.string().min(1).max(100_000) })
          .parse(await body(request));
        await store.enqueuePrompt(id, input.prompt);
        return json(response, 202, { ok: true });
      }
      if (
        (action === "stop" || action === "resume") &&
        request.method === "POST"
      ) {
        await db`INSERT INTO jobs(id,agent_session_id,kind) VALUES (${crypto.randomUUID()},${id},${action})`;
        return json(response, 202, { ok: true });
      }
    }
    if (url.pathname === "/api/approvals" && request.method === "GET") {
      return json(
        response,
        200,
        await db`SELECT id,agent_session_id,request,status,expires_at FROM approvals WHERE status='pending' ORDER BY created_at`,
      );
    }
    const approvalMatch = url.pathname.match(
      /^\/api\/approvals\/([0-9a-f-]+)$/,
    );
    if (approvalMatch && request.method === "POST") {
      const input = z
        .object({ decision: z.enum(["approved", "rejected"]) })
        .parse(await body(request));
      await store.resolveApproval(approvalMatch[1] ?? "", input.decision);
      return json(response, 200, { ok: true });
    }
    if (url.pathname === "/api/settings" && request.method === "GET") {
      const settings =
        await db`SELECT key,value FROM settings WHERE key NOT IN ('discord_token')`;
      return json(response, 200, settings);
    }
    if (url.pathname === "/api/settings" && request.method === "PUT") {
      const input = z
        .object({
          paused: z.boolean().optional(),
          discordOwnerId: z
            .string()
            .regex(/^\d{17,20}$/)
            .optional(),
          discordToken: z.string().min(1).max(200).optional(),
        })
        .parse(await body(request));
      if (input.paused !== undefined)
        await db`INSERT INTO settings(key,value) VALUES ('paused',${db.json(input.paused)}) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`;
      if (input.discordOwnerId)
        await db`INSERT INTO settings(key,value) VALUES ('discord_owner_id',${db.json(input.discordOwnerId)}) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`;
      if (input.discordToken)
        await db`INSERT INTO secrets(key,ciphertext) VALUES ('discord_token',${encrypt(input.discordToken, encryptionKey)}) ON CONFLICT(key) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,updated_at=now()`;
      await store.audit("settings.update", {
        paused: input.paused,
        discordConfigured: Boolean(input.discordToken),
      });
      return json(response, 200, { ok: true });
    }
    if (url.pathname === "/api/mcp" && request.method === "GET") {
      return json(
        response,
        200,
        await db`SELECT id,name,transport,url,enabled,header_secret_key IS NOT NULL AS has_secret_header FROM mcp_servers ORDER BY name`,
      );
    }
    if (url.pathname === "/api/mcp" && request.method === "POST") {
      const input = z
        .object({
          name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
          transport: z.enum(["http", "sse"]),
          url: z.string().url(),
          headers: z.record(z.string(), z.string()).optional(),
        })
        .parse(await body(request));
      let headerSecretKey: string | null = null;
      if (input.headers && Object.keys(input.headers).length) {
        headerSecretKey = `mcp_headers_${crypto.randomUUID()}`;
        await db`INSERT INTO secrets(key,ciphertext) VALUES (${headerSecretKey},${encrypt(JSON.stringify(input.headers), encryptionKey)})`;
      }
      await db`INSERT INTO mcp_servers(id,name,transport,url,header_secret_key) VALUES (${crypto.randomUUID()},${input.name},${input.transport},${input.url},${headerSecretKey})`;
      await store.audit("mcp.create", {
        name: input.name,
        transport: input.transport,
      });
      return json(response, 201, { ok: true });
    }
    if (url.pathname === "/api/audit" && request.method === "GET")
      return json(
        response,
        200,
        await db`SELECT id,action,detail,created_at FROM audit_log ORDER BY id DESC LIMIT 100`,
      );
    return json(response, 404, { error: "not found" });
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues.map((issue) => issue.message).join(", ")
        : "request failed";
    console.error(
      JSON.stringify({ level: "error", event: "web.request", message }),
    );
    return json(response, error instanceof z.ZodError ? 400 : 500, {
      error: message,
    });
  }
});

server.listen(Number(process.env.PORT ?? 3000));
const shutdown = async () => {
  server.close();
  await db.end();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

function page(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenTentacles</title><style>
  :root{color-scheme:dark;font-family:ui-sans-serif,system-ui;background:#111827;color:#e5e7eb}body{margin:0;display:grid;grid-template-columns:280px 1fr;min-height:100vh}aside{padding:20px;border-right:1px solid #263244;background:#0f172a}main{max-width:900px;width:100%;padding:32px;margin:auto}button,input{font:inherit;padding:10px;border-radius:8px;border:1px solid #374151}button{background:#2563eb;color:white;cursor:pointer}.session{padding:10px;border-bottom:1px solid #263244}.muted{color:#9ca3af}form{display:flex;gap:8px;flex-wrap:wrap}input{background:#111827;color:inherit;flex:1;min-width:120px}pre{white-space:pre-wrap;background:#0b1220;padding:16px;border-radius:10px}@media(max-width:700px){body{display:block}aside{border:0}}</style></head><body>
  <aside><h1>OpenTentacles</h1><p class="muted">GitHub-hosted Copilot sessions</p><div id="sessions"></div></aside>
  <main><h2 id="title">Session control</h2><p class="muted">Create a cloud session, then send a turn after it is ready.</p><form id="new"><input name="owner" placeholder="owner" required><input name="repo" placeholder="repository" required><input name="branch" placeholder="branch"><input name="model" placeholder="model"><button>Create</button></form><h3>Transcript</h3><pre id="events">Select a session.</pre><form id="prompt"><input name="prompt" placeholder="Message to Copilot" required><button>Send</button></form></main>
  <script>
  let selected,stream; const $=id=>document.getElementById(id);
  async function api(path,options={}){const r=await fetch(path,{headers:{'content-type':'application/json'},...options});if(!r.ok)throw new Error((await r.json()).error);return r.json()}
  async function load(){try{const sessions=await api('/api/sessions');$('sessions').innerHTML=sessions.map(s=>'<div class=session><button data-id='+s.id+'>'+s.repository_owner+'/'+s.repository_name+'</button><div class=muted>'+s.status+'</div></div>').join('')||'<p class=muted>No sessions yet.</p>';document.querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>select(b.dataset.id))}catch{auth()}}
  async function auth(){const setup=await api('/api/setup');$('title').textContent=setup.required?'First-run setup':'Sign in';$('new').innerHTML='<input name=username placeholder=username required><input name=password type=password placeholder="12+ character password" required><button>'+ (setup.required?'Create admin':'Sign in')+'</button>';$('new').onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target));await api(setup.required?'/api/setup':'/api/login',{method:'POST',body:JSON.stringify(d)});location.reload()}}
  async function select(id){selected=id;const messages=await api('/api/sessions/'+id);$('events').textContent=messages.map(m=>m.role+': '+m.content).join('\\n\\n')||'Connecting…';stream?.close();stream=new EventSource('/api/sessions/'+id+'/events');stream.onmessage=e=>{$('events').textContent+= '\\n'+e.data};stream.addEventListener('session.error',e=>{$('events').textContent+='\\nError: '+e.data})}
  $('new').onsubmit=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.target));const s=await api('/api/sessions',{method:'POST',body:JSON.stringify(data)});await load();select(s.id)};
  $('prompt').onsubmit=async e=>{e.preventDefault();if(!selected)return;const data=Object.fromEntries(new FormData(e.target));await api('/api/sessions/'+selected+'/prompt',{method:'POST',body:JSON.stringify(data)});e.target.reset()};
  load();
  </script></body></html>`;
}
