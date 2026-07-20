#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";

type StoredState = {
  baseUrl: string;
  sessionCookie?: string;
  lastSessionId?: string;
};

type Session = {
  id: string;
  repository_owner: string;
  repository_name: string;
  branch: string | null;
  model: string | null;
  status: string;
  mission_control_url: string | null;
  created_at?: string;
};

type Message = {
  id: string;
  role: string;
  content: string;
  created_at: string;
};

type Approval = {
  id: string;
  agent_session_id: string;
  request: unknown;
  status: string;
  expires_at: string;
};

type SessionTranscript = {
  messages: Message[];
  lastEventId: number;
};

type StreamEvent = {
  id: number;
  type: string;
  payload: Record<string, unknown>;
};

const stateDir = join(homedir(), ".opententacles");
const statePath = join(stateDir, "cli.json");

class ApiClient {
  constructor(private readonly state: StoredState) {}

  async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<{ data: T; headers: Headers }> {
    const response = await this.fetch(path, init);
    const text = await response.text();
    const data = text ? (JSON.parse(text) as { error?: string }) : {};
    if (!response.ok) {
      throw new Error(
        typeof data.error === "string"
          ? data.error
          : `request failed (${response.status})`,
      );
    }
    return { data: data as T, headers: response.headers };
  }

  fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.state.sessionCookie) {
      headers.set(
        "cookie",
        `ot_session=${encodeURIComponent(this.state.sessionCookie)}`,
      );
    }
    return fetch(new URL(path, this.state.baseUrl), { ...init, headers });
  }
}

async function main(): Promise<void> {
  const state = await loadState();
  const [command = "chat", ...args] = process.argv.slice(2);
  switch (command) {
    case "login":
      await login(state, args[0]);
      return;
    case "logout":
      await logout(state);
      return;
    case "sessions":
      await listSessionsCommand(state);
      return;
    case "approvals":
      await approvalsCommand(state);
      return;
    case "approve":
      await decisionCommand(state, args[0], "approved");
      return;
    case "deny":
      await decisionCommand(state, args[0], "rejected");
      return;
    case "new":
      await newSessionCommand(state, args);
      return;
    case "resume":
      await sessionActionCommand(state, args[0], "resume");
      return;
    case "stop":
      await sessionActionCommand(state, args[0], "stop");
      return;
    case "chat":
      await chatCommand(state, args[0]);
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      await chatCommand(state, command);
  }
}

async function loadState(): Promise<StoredState> {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as StoredState;
    return {
      baseUrl: normalizeBaseUrl(parsed.baseUrl),
      sessionCookie: parsed.sessionCookie,
      lastSessionId: parsed.lastSessionId,
    };
  } catch {
    return {
      baseUrl: normalizeBaseUrl(process.env.OPENTENTACLES_APP_URL),
    };
  }
}

async function saveState(state: StoredState): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function normalizeBaseUrl(value?: string): string {
  return new URL(value ?? "http://localhost:3000").toString();
}

async function requireApi(state: StoredState): Promise<ApiClient> {
  if (!state.sessionCookie) {
    throw new Error("not logged in; run `bun run cli login`");
  }
  return new ApiClient(state);
}

async function login(state: StoredState, baseUrlArg?: string): Promise<void> {
  state.baseUrl = normalizeBaseUrl(baseUrlArg ?? state.baseUrl);
  const api = new ApiClient(state);
  const setup = await api.request<{ required: boolean }>("/api/setup");
  if (setup.data.required) {
    throw new Error("first-run setup still requires the web dashboard");
  }
  const username = await prompt("username: ");
  const password = await promptSecret("password: ");
  const response = await api.fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: state.baseUrl },
    body: JSON.stringify({ username, password }),
  });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as { error?: string }) : {};
  if (!response.ok) {
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : `request failed (${response.status})`,
    );
  }
  const cookie = readSessionCookie(response.headers);
  if (!cookie) throw new Error("login succeeded without a session cookie");
  state.sessionCookie = cookie;
  await saveState(state);
  console.log(`logged in to ${state.baseUrl}`);
}

async function logout(state: StoredState): Promise<void> {
  if (state.sessionCookie) {
    try {
      await new ApiClient(state).fetch("/api/logout", {
        method: "POST",
        headers: { origin: state.baseUrl },
      });
    } catch {
      // ponytail: local logout still works if the server is unreachable.
    }
  }
  await rm(statePath, { force: true });
  console.log("logged out");
}

function readSessionCookie(headers: Headers): string | undefined {
  const withSetCookies = headers as Headers & { getSetCookie?: () => string[] };
  const values = withSetCookies.getSetCookie?.() ?? [];
  const combined = values.length
    ? values.join(";")
    : (headers.get("set-cookie") ?? "");
  const match = combined.match(/ot_session=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

async function listSessions(api: ApiClient): Promise<Session[]> {
  const response = await api.request<Session[]>("/api/sessions");
  return response.data;
}

async function listSessionsCommand(state: StoredState): Promise<void> {
  const sessions = await listSessions(await requireApi(state));
  printSessions(sessions);
}

async function approvalsCommand(state: StoredState): Promise<void> {
  const approvals = await pendingApprovals(await requireApi(state));
  printApprovals(approvals);
}

async function pendingApprovals(api: ApiClient): Promise<Approval[]> {
  const response = await api.request<Approval[]>("/api/approvals");
  return response.data;
}

async function decisionCommand(
  state: StoredState,
  id: string | undefined,
  decision: "approved" | "rejected",
): Promise<void> {
  if (!id) throw new Error(`missing approval id for ${decision}`);
  const api = await requireApi(state);
  await api.request(`/api/approvals/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: state.baseUrl },
    body: JSON.stringify({ decision }),
  });
  console.log(`${decision === "approved" ? "approved" : "denied"} ${id}`);
}

async function newSessionCommand(
  state: StoredState,
  args: string[],
): Promise<void> {
  const [repoSpec, branch, model] = args;
  if (!repoSpec)
    throw new Error("usage: bun run cli new owner/repo [branch] [model]");
  const api = await requireApi(state);
  const session = await createSession(
    api,
    repoSpec,
    branch,
    model,
    state.baseUrl,
  );
  state.lastSessionId = session.id;
  await saveState(state);
  printSession(session);
}

async function createSession(
  api: ApiClient,
  repoSpec: string,
  branch: string | undefined,
  model: string | undefined,
  baseUrl: string,
): Promise<Session> {
  const [owner, repo] = repoSpec.split("/");
  if (!owner || !repo) {
    throw new Error("repository must be in owner/repo form");
  }
  const response = await api.request<Session>("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ owner, repo, branch, model }),
  });
  return response.data;
}

async function sessionActionCommand(
  state: StoredState,
  idArg: string | undefined,
  action: "resume" | "stop",
): Promise<void> {
  const api = await requireApi(state);
  const id = idArg ?? state.lastSessionId;
  if (!id) throw new Error(`no session selected for ${action}`);
  await api.request(`/api/sessions/${id}/${action}`, {
    method: "POST",
    headers: { origin: state.baseUrl },
  });
  console.log(`${action} queued for ${id}`);
}

async function chatCommand(
  state: StoredState,
  sessionArg: string | undefined,
): Promise<void> {
  const api = await requireApi(state);
  const sessions = await listSessions(api);
  const initialSession = pickSession(
    sessions,
    sessionArg ?? state.lastSessionId,
  );
  if (!initialSession) {
    console.log(
      "no sessions yet; create one with /new owner/repo [branch] [model]",
    );
    return;
  }
  let current: Session = initialSession;
  state.lastSessionId = current.id;
  await saveState(state);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  let transcript = await fetchTranscript(api, current.id);
  let messageCount = transcript.messages.length;
  let lastEventId = transcript.lastEventId;
  let sawAssistantDelta = false;
  let streamController = new AbortController();

  const printCurrent = async () => {
    console.log(
      `\n${current.repository_owner}/${current.repository_name} ${current.branch ? `(${current.branch})` : ""} - ${current.status}`,
    );
    if (current.mission_control_url) console.log(current.mission_control_url);
    printMessages(transcript.messages);
  };

  const syncMessages = async () => {
    transcript = await fetchTranscript(api, current.id);
    for (const message of transcript.messages.slice(messageCount)) {
      if (sawAssistantDelta && message.role === "assistant") continue;
      console.log(`${message.role}: ${message.content}`);
    }
    messageCount = transcript.messages.length;
    lastEventId = Math.max(lastEventId, transcript.lastEventId);
    sawAssistantDelta = false;
  };

  const restartStream = () => {
    streamController.abort();
    streamController = new AbortController();
    void streamSession(
      api,
      current.id,
      lastEventId,
      streamController.signal,
      async (event) => {
        lastEventId = Math.max(lastEventId, event.id);
        if (event.type === "assistant.message_delta") {
          sawAssistantDelta = true;
          const delta = event.payload.deltaContent;
          if (typeof delta === "string") process.stdout.write(delta);
          return;
        }
        if (event.type === "approval.pending") {
          process.stdout.write(
            `\napproval pending: ${String(event.payload.approvalId ?? "unknown")}\n`,
          );
          rl.prompt();
          return;
        }
        if (event.type === "session.ready") {
          process.stdout.write("\nready\n");
          await syncMessages();
          rl.prompt();
          return;
        }
        if (event.type === "session.error") {
          process.stdout.write(
            `\nerror: ${String(event.payload.message ?? "request failed")}\n`,
          );
          await syncMessages();
          rl.prompt();
        }
      },
    );
  };

  await printCurrent();
  restartStream();
  printChatHelp();
  rl.setPrompt("> ");
  rl.prompt();

  try {
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) {
        rl.prompt();
        continue;
      }
      if (line.startsWith("/")) {
        const keepGoing = await handleChatCommand({
          api,
          baseUrl: state.baseUrl,
          line,
          getSessions: () => listSessions(api),
          getCurrent: () => current,
          setCurrent: async (next) => {
            current = next;
            state.lastSessionId = next.id;
            await saveState(state);
            transcript = await fetchTranscript(api, current.id);
            messageCount = transcript.messages.length;
            lastEventId = transcript.lastEventId;
            sawAssistantDelta = false;
            await printCurrent();
            restartStream();
          },
          syncMessages,
        });
        if (!keepGoing) break;
        rl.prompt();
        continue;
      }
      await api.request(`/api/sessions/${current.id}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: state.baseUrl },
        body: JSON.stringify({ prompt: line }),
      });
      console.log(`you: ${line}`);
      messageCount += 1;
      rl.prompt();
    }
  } finally {
    streamController.abort();
    rl.close();
  }
}

type ChatContext = {
  api: ApiClient;
  baseUrl: string;
  line: string;
  getSessions: () => Promise<Session[]>;
  getCurrent: () => Session;
  setCurrent: (session: Session) => Promise<void>;
  syncMessages: () => Promise<void>;
};

async function handleChatCommand(context: ChatContext): Promise<boolean> {
  const [command, ...args] = context.line.split(/\s+/);
  switch (command) {
    case "/help":
      printChatHelp();
      return true;
    case "/quit":
    case "/exit":
      return false;
    case "/sessions": {
      const sessions = await context.getSessions();
      printSessions(sessions);
      return true;
    }
    case "/use": {
      const target = args[0];
      if (!target) throw new Error("usage: /use <session-id-or-number>");
      const sessions = await context.getSessions();
      const next = pickSession(sessions, target);
      if (!next) throw new Error(`unknown session: ${target}`);
      await context.setCurrent(next);
      return true;
    }
    case "/new": {
      if (!args[0]) throw new Error("usage: /new owner/repo [branch] [model]");
      const session = await createSession(
        context.api,
        args[0],
        args[1],
        args[2],
        context.baseUrl,
      );
      await context.setCurrent(session);
      return true;
    }
    case "/resume":
    case "/stop": {
      const action = command === "/resume" ? "resume" : "stop";
      await context.api.request(
        `/api/sessions/${context.getCurrent().id}/${action}`,
        { method: "POST", headers: { origin: context.baseUrl } },
      );
      console.log(`${action} queued`);
      return true;
    }
    case "/status": {
      const sessions = await context.getSessions();
      const current = pickSession(sessions, context.getCurrent().id);
      if (current) {
        await context.setCurrent(current);
      }
      return true;
    }
    case "/approvals": {
      printApprovals(await pendingApprovals(context.api));
      return true;
    }
    case "/approve":
    case "/deny": {
      const approvalId = args[0];
      if (!approvalId) throw new Error(`usage: ${command} <approval-id>`);
      await context.api.request(`/api/approvals/${approvalId}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: context.baseUrl,
        },
        body: JSON.stringify({
          decision: command === "/approve" ? "approved" : "rejected",
        }),
      });
      console.log(
        `${command === "/approve" ? "approved" : "denied"} ${approvalId}`,
      );
      return true;
    }
    case "/open": {
      const current = context.getCurrent();
      console.log(current.mission_control_url ?? "no Mission Control URL yet");
      return true;
    }
    case "/refresh": {
      await context.syncMessages();
      return true;
    }
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

async function fetchTranscript(
  api: ApiClient,
  sessionId: string,
): Promise<SessionTranscript> {
  const response = await api.request<Message[]>(`/api/sessions/${sessionId}`);
  return {
    messages: response.data,
    lastEventId: Number(response.headers.get("x-last-event-id") ?? 0),
  };
}

async function streamSession(
  api: ApiClient,
  sessionId: string,
  after: number,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => Promise<void> | void,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const response = await api.fetch(
        `/api/sessions/${sessionId}/events?after=${after}`,
        {
          headers: { accept: "text/event-stream" },
          signal,
        },
      );
      if (!response.ok) throw new Error(`stream failed (${response.status})`);
      const reader = response.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = "";
      while (!signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        while (true) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary === -1) break;
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = parseEvent(block);
          if (!event) continue;
          after = Math.max(after, event.id);
          await onEvent(event);
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      console.error(
        `stream disconnected: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      await sleep(1_000);
    }
  }
}

function parseEvent(block: string): StreamEvent | null {
  let id = 0;
  let type = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("id:")) id = Number(line.slice(3).trim()) || 0;
    if (line.startsWith("event:")) type = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  if (!data.length) return null;
  return {
    id,
    type,
    payload: JSON.parse(data.join("\n")) as Record<string, unknown>,
  };
}

function pickSession(
  sessions: Session[],
  target?: string,
): Session | undefined {
  if (!target) return sessions[0];
  const index = Number(target);
  if (Number.isInteger(index) && index > 0) return sessions[index - 1];
  return sessions.find((session) => session.id === target);
}

function printSessions(sessions: Session[]): void {
  if (!sessions.length) {
    console.log("no sessions");
    return;
  }
  for (const [index, session] of sessions.entries()) {
    const branch = session.branch ? ` (${session.branch})` : "";
    const model = session.model ? ` [${session.model}]` : "";
    console.log(
      `${index + 1}. ${session.id} ${session.repository_owner}/${session.repository_name}${branch} - ${session.status}${model}`,
    );
    if (session.mission_control_url)
      console.log(`   ${session.mission_control_url}`);
  }
}

function printApprovals(approvals: Approval[]): void {
  if (!approvals.length) {
    console.log("no pending approvals");
    return;
  }
  for (const approval of approvals) {
    console.log(
      `${approval.id} session=${approval.agent_session_id} expires=${approval.expires_at}`,
    );
    console.log(JSON.stringify(approval.request, null, 2));
  }
}

function printSession(session: Session): void {
  console.log(
    `${session.id} ${session.repository_owner}/${session.repository_name} - ${session.status}`,
  );
  if (session.branch) console.log(`branch: ${session.branch}`);
  if (session.model) console.log(`model: ${session.model}`);
  if (session.mission_control_url) console.log(session.mission_control_url);
}

function printMessages(messages: Message[]): void {
  if (!messages.length) {
    console.log("no messages yet");
    return;
  }
  for (const message of messages) {
    console.log(`${message.role}: ${message.content}`);
  }
}

function printHelp(): void {
  console.log(`OpenTentacles CLI

Commands:
  bun run cli login [url]
  bun run cli logout
  bun run cli sessions
  bun run cli approvals
  bun run cli approve <approval-id>
  bun run cli deny <approval-id>
  bun run cli new owner/repo [branch] [model]
  bun run cli resume <session-id>
  bun run cli stop <session-id>
  bun run cli chat [session-id]
`);
}

function printChatHelp(): void {
  console.log(
    `\n/chat commands: /help /sessions /use <id|number> /new owner/repo [branch] [model] /status /resume /stop /approvals /approve <id> /deny <id> /open /refresh /quit\n`,
  );
}

async function prompt(label: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(label)).trim();
  } finally {
    rl.close();
  }
}

async function promptSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return prompt(label);
  }
  return new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const previousRaw = stdin.isRaw;
    let value = "";

    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode?.(Boolean(previousRaw));
      stdin.pause();
    };

    const onData = (chunk: string | Buffer) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          stdout.write("\n");
          cleanup();
          resolve(value.trim());
          return;
        }
        if (character === "\u007f") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        value += character;
        stdout.write("*");
      }
    };

    stdout.write(label);
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : "request failed");
  process.exitCode = 1;
});
