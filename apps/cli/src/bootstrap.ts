import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { requireKey } from "../../../packages/core/src/crypto.ts";
import { connectDatabase } from "../../../packages/core/src/db.ts";
import { migrate } from "../../../packages/core/src/migrations.ts";

type StoredState = {
  baseUrl: string;
  sessionCookie?: string;
  lastSessionId?: string;
};

type Session = { id: string };

type LocalEnv = {
  DATABASE_URL?: string;
  OPENTENTACLES_APP_URL?: string;
  OPENTENTACLES_ENCRYPTION_KEY?: string;
  OPENTENTACLES_SESSION_KEY?: string;
  COPILOT_GITHUB_TOKEN?: string;
};

type SetupCredentials = {
  username: string;
  password: string;
};

type ServiceName = "web" | "gateway" | "harness";

type ServiceHandle = {
  name: ServiceName;
  child: ChildProcess;
  stop: () => Promise<void>;
};

const stateDir = join(homedir(), ".opententacles");
const statePath = join(stateDir, "cli.json");
const envPath = resolve(process.cwd(), ".env");
const cliDir = dirname(fileURLToPath(import.meta.url));

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

function normalizeBaseUrl(value?: string): string {
  return new URL(value ?? "http://localhost:3000").toString();
}

async function saveState(state: StoredState): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function readLocalEnv(): Promise<LocalEnv> {
  try {
    return parseEnv(await readFile(envPath, "utf8"));
  } catch {
    return {};
  }
}

function parseEnv(text: string): LocalEnv {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    env[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return env as LocalEnv;
}

function mergedEnv(fileEnv: LocalEnv): LocalEnv {
  return {
    DATABASE_URL: process.env.DATABASE_URL ?? fileEnv.DATABASE_URL,
    OPENTENTACLES_APP_URL:
      process.env.OPENTENTACLES_APP_URL ?? fileEnv.OPENTENTACLES_APP_URL,
    OPENTENTACLES_ENCRYPTION_KEY:
      process.env.OPENTENTACLES_ENCRYPTION_KEY ??
      fileEnv.OPENTENTACLES_ENCRYPTION_KEY,
    OPENTENTACLES_SESSION_KEY:
      process.env.OPENTENTACLES_SESSION_KEY ??
      fileEnv.OPENTENTACLES_SESSION_KEY,
    COPILOT_GITHUB_TOKEN:
      process.env.COPILOT_GITHUB_TOKEN ?? fileEnv.COPILOT_GITHUB_TOKEN,
  };
}

async function writeLocalEnv(env: LocalEnv): Promise<void> {
  const lines = [
    "# Managed by the OpenTentacles CLI",
    `DATABASE_URL=${env.DATABASE_URL ?? ""}`,
    `OPENTENTACLES_APP_URL=${env.OPENTENTACLES_APP_URL ?? "http://localhost:3000"}`,
    `OPENTENTACLES_ENCRYPTION_KEY=${env.OPENTENTACLES_ENCRYPTION_KEY ?? ""}`,
    `OPENTENTACLES_SESSION_KEY=${env.OPENTENTACLES_SESSION_KEY ?? ""}`,
    "",
    "# Harness service only",
    `COPILOT_GITHUB_TOKEN=${env.COPILOT_GITHUB_TOKEN ?? ""}`,
    "",
  ];
  await writeFile(envPath, lines.join("\n"), "utf8");
}

function requireEnvValue(env: LocalEnv, key: keyof LocalEnv): string {
  const value = env[key];
  if (!value)
    throw new Error(`${key} is required; run \`opententacles setup\``);
  return value;
}

function generateKey(): string {
  return randomBytes(32).toString("base64");
}

async function migrateDatabase(databaseUrl: string): Promise<void> {
  const db = connectDatabase(databaseUrl);
  try {
    await migrate(db);
  } finally {
    await db.end();
  }
}

async function databaseOk(databaseUrl: string): Promise<boolean> {
  const db = connectDatabase(databaseUrl);
  try {
    await db`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await db.end().catch(() => undefined);
  }
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

function report(name: string, ok: boolean, detail?: string): void {
  console.log(
    `${ok ? "[ok]" : "[warn]"} ${name}${detail ? ` - ${detail}` : ""}`,
  );
}

function reportKey(name: string, value?: string): void {
  if (!value) {
    report(name, false, "required");
    return;
  }
  try {
    requireKey(value, name);
    report(name, true);
  } catch (error) {
    report(name, false, error instanceof Error ? error.message : "invalid key");
  }
}
export async function setupCommand(state: StoredState): Promise<void> {
  const fileEnv = await readLocalEnv();
  const existing = mergedEnv(fileEnv);
  const databaseUrl = await promptRequired(
    "DATABASE_URL",
    existing.DATABASE_URL,
  );
  const appUrl = normalizeBaseUrl(
    await promptWithDefault(
      "App URL",
      existing.OPENTENTACLES_APP_URL ?? "http://localhost:3000",
    ),
  );
  const encryptionKey = existing.OPENTENTACLES_ENCRYPTION_KEY ?? generateKey();
  const sessionKey = existing.OPENTENTACLES_SESSION_KEY ?? generateKey();
  let copilotToken = existing.COPILOT_GITHUB_TOKEN;
  if (!copilotToken) {
    copilotToken = await promptSecretOptional(
      "COPILOT_GITHUB_TOKEN (optional, needed for harness): ",
    );
  } else if (await confirm("Replace existing COPILOT_GITHUB_TOKEN?", false)) {
    copilotToken = await promptSecretOptional(
      "COPILOT_GITHUB_TOKEN (optional, needed for harness): ",
    );
  }

  requireKey(encryptionKey, "OPENTENTACLES_ENCRYPTION_KEY");
  requireKey(sessionKey, "OPENTENTACLES_SESSION_KEY");

  const nextEnv: LocalEnv = {
    DATABASE_URL: databaseUrl,
    OPENTENTACLES_APP_URL: appUrl,
    OPENTENTACLES_ENCRYPTION_KEY: encryptionKey,
    OPENTENTACLES_SESSION_KEY: sessionKey,
    COPILOT_GITHUB_TOKEN: copilotToken,
  };
  await writeLocalEnv(nextEnv);
  await migrateDatabase(databaseUrl);

  const appState: StoredState = {
    baseUrl: appUrl,
    sessionCookie: state.baseUrl === appUrl ? state.sessionCookie : undefined,
    lastSessionId: state.lastSessionId,
  };
  let temporaryWeb: ServiceHandle | undefined;

  try {
    if (!(await healthOk(appUrl))) {
      if (!isLocalUrl(appUrl)) {
        throw new Error(
          `web is not reachable at ${appUrl}; deploy the web service first or use a local URL for setup`,
        );
      }
      temporaryWeb = await startService("web", nextEnv, {
        port: resolvePort(appUrl, 3000),
        quiet: true,
      });
      await waitForHealth(appUrl, 30_000);
    }

    const api = new ApiClient(appState);
    const setup = await api.request<{ required: boolean }>("/api/setup");
    let credentials: SetupCredentials | undefined;
    if (setup.data.required) {
      credentials = await collectCredentials();
      await api.request("/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json", origin: appUrl },
        body: JSON.stringify(credentials),
      });
      console.log("created first administrator");
    }

    await ensureAuthenticated(appState, credentials);

    if (await confirm("Configure Discord now?", false)) {
      const ownerId = await promptRequired("Discord owner ID", undefined);
      const discordToken = await promptSecretRequired("Discord bot token: ");
      await new ApiClient(appState).request("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json", origin: appUrl },
        body: JSON.stringify({ discordOwnerId: ownerId, discordToken }),
      });
      console.log("stored Discord configuration");
    }

    await saveState(appState);
    console.log(`wrote ${envPath}`);
    console.log("next: opententacles up");
    console.log("then: opententacles chat");
    if (!copilotToken) {
      console.log(
        "warning: COPILOT_GITHUB_TOKEN is empty, so `opententacles up` will skip the harness",
      );
    }
  } finally {
    await temporaryWeb?.stop();
  }
}

export async function upCommand(): Promise<void> {
  const env = mergedEnv(await readLocalEnv());
  const databaseUrl = requireEnvValue(env, "DATABASE_URL");
  const appUrl = normalizeBaseUrl(
    requireEnvValue(env, "OPENTENTACLES_APP_URL"),
  );
  requireKey(
    requireEnvValue(env, "OPENTENTACLES_ENCRYPTION_KEY"),
    "OPENTENTACLES_ENCRYPTION_KEY",
  );
  requireKey(
    requireEnvValue(env, "OPENTENTACLES_SESSION_KEY"),
    "OPENTENTACLES_SESSION_KEY",
  );

  await migrateDatabase(databaseUrl);

  const sharedEnv: LocalEnv = {
    DATABASE_URL: databaseUrl,
    OPENTENTACLES_APP_URL: appUrl,
    OPENTENTACLES_ENCRYPTION_KEY: env.OPENTENTACLES_ENCRYPTION_KEY,
    OPENTENTACLES_SESSION_KEY: env.OPENTENTACLES_SESSION_KEY,
    COPILOT_GITHUB_TOKEN: env.COPILOT_GITHUB_TOKEN,
  };

  const services: ServiceHandle[] = [];
  services.push(
    await startService("web", sharedEnv, { port: resolvePort(appUrl, 3000) }),
  );
  services.push(await startService("gateway", sharedEnv, { port: 3001 }));
  if (env.COPILOT_GITHUB_TOKEN) {
    services.push(await startService("harness", sharedEnv, { port: 3002 }));
  } else {
    console.log(
      "[harness] skipped (set COPILOT_GITHUB_TOKEN in .env for full cloud-session support)",
    );
  }

  await waitForHealth(appUrl, 30_000);
  console.log(`web ready at ${appUrl}`);
  console.log("press Ctrl+C to stop all local services");

  try {
    await waitForSignalOrExit(services);
  } finally {
    await Promise.allSettled(services.map((service) => service.stop()));
  }
}

export async function doctorCommand(state: StoredState): Promise<void> {
  const fileExists = existsSync(envPath);
  const env = mergedEnv(await readLocalEnv());
  console.log(`env file: ${fileExists ? envPath : "missing"}`);
  report(
    "DATABASE_URL",
    Boolean(env.DATABASE_URL),
    env.DATABASE_URL ? undefined : "required",
  );
  report(
    "OPENTENTACLES_APP_URL",
    Boolean(env.OPENTENTACLES_APP_URL),
    env.OPENTENTACLES_APP_URL ? undefined : "required",
  );
  reportKey("OPENTENTACLES_ENCRYPTION_KEY", env.OPENTENTACLES_ENCRYPTION_KEY);
  reportKey("OPENTENTACLES_SESSION_KEY", env.OPENTENTACLES_SESSION_KEY);
  report(
    "COPILOT_GITHUB_TOKEN",
    Boolean(env.COPILOT_GITHUB_TOKEN),
    env.COPILOT_GITHUB_TOKEN ? undefined : "harness will be skipped",
  );

  if (env.DATABASE_URL) {
    const ok = await databaseOk(env.DATABASE_URL);
    report("database connection", ok, ok ? undefined : "unreachable");
  }

  if (env.OPENTENTACLES_APP_URL) {
    const appUrl = normalizeBaseUrl(env.OPENTENTACLES_APP_URL);
    const health = await healthOk(appUrl);
    report("web /health", health, health ? undefined : "not reachable");
    if (health) {
      const api = new ApiClient({
        baseUrl: appUrl,
        sessionCookie:
          state.baseUrl === appUrl ? state.sessionCookie : undefined,
      });
      try {
        const setup = await api.request<{ required: boolean }>("/api/setup");
        report(
          "first-run setup",
          !setup.data.required,
          setup.data.required ? "admin not created yet" : undefined,
        );
      } catch {
        report("first-run setup", false, "could not query setup state");
      }
      if (state.baseUrl === appUrl && state.sessionCookie) {
        try {
          await api.request<Session[]>("/api/sessions");
          report("saved login", true);
        } catch {
          report("saved login", false, "session cookie is missing or expired");
        }
      } else {
        report("saved login", false, "run `opententacles login` after setup");
      }
    }
  }
}

async function ensureAuthenticated(
  state: StoredState,
  credentials?: SetupCredentials,
): Promise<void> {
  const api = new ApiClient(state);
  if (state.sessionCookie) {
    try {
      await api.request<Session[]>("/api/sessions");
      return;
    } catch {
      state.sessionCookie = undefined;
    }
  }
  const loginCredentials = credentials ?? (await collectCredentials("Sign in"));
  state.sessionCookie = await loginWithCredentials(
    api,
    loginCredentials,
    state.baseUrl,
  );
}
async function loginWithCredentials(
  api: ApiClient,
  credentials: SetupCredentials,
  origin: string,
): Promise<string> {
  const response = await api.fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(credentials),
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
  return cookie;
}

async function collectCredentials(
  title = "Create administrator",
): Promise<SetupCredentials> {
  console.log(title);
  const username = await promptRequired("username", undefined);
  const password = await promptSecretRequired("password (12+ chars): ");
  const confirmPassword = await promptSecretRequired("confirm password: ");
  if (password !== confirmPassword) throw new Error("passwords do not match");
  return { username, password };
}

async function startService(
  name: ServiceName,
  env: LocalEnv,
  options: { port: number; quiet?: boolean },
): Promise<ServiceHandle> {
  const entry = resolveServiceEntry(name);
  const child = spawn(entry.command, entry.args, {
    env: {
      ...process.env,
      DATABASE_URL: env.DATABASE_URL,
      OPENTENTACLES_APP_URL: env.OPENTENTACLES_APP_URL,
      OPENTENTACLES_ENCRYPTION_KEY: env.OPENTENTACLES_ENCRYPTION_KEY,
      OPENTENTACLES_SESSION_KEY: env.OPENTENTACLES_SESSION_KEY,
      COPILOT_GITHUB_TOKEN: env.COPILOT_GITHUB_TOKEN,
      PORT: String(options.port),
      NODE_ENV: process.env.NODE_ENV ?? "production",
    },
    stdio: options.quiet ? "ignore" : "pipe",
  });
  if (!options.quiet) pipeLogs(child, name);
  return { name, child, stop: () => stopChild(child) };
}

function resolveServiceEntry(name: ServiceName): {
  command: string;
  args: string[];
} {
  const distCandidates = [
    join(cliDir, ".."),
    join(cliDir, "..", "..", "..", "dist"),
    join(process.cwd(), "dist"),
  ];
  for (const candidate of distCandidates) {
    const entry = join(candidate, name, "index.js");
    if (existsSync(entry)) return { command: process.execPath, args: [entry] };
  }
  throw new Error(
    `could not find the built ${name} service; build the project or install the packaged CLI`,
  );
}

function pipeLogs(child: ChildProcess, label: string): void {
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => prefix(label, chunk));
  child.stderr?.on("data", (chunk) => prefix(label, chunk));
}

function prefix(label: string, chunk: string): void {
  for (const line of chunk.split(/\r?\n/)) {
    if (!line) continue;
    console.log(`[${label}] ${line}`);
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  await Promise.race([
    onceExit(child),
    sleep(5_000).then(() => {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    }),
  ]);
}

function onceExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function waitForSignalOrExit(services: ServiceHandle[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolve();
    };
    const onSignal = () => finish();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    for (const service of services) {
      service.child.once("exit", (code) => {
        if (code && code !== 0) {
          reject(new Error(`${service.name} exited with code ${code}`));
          return;
        }
        finish();
      });
    }
  });
}

async function healthOk(url: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/health", url));
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await healthOk(url)) return;
    await sleep(500);
  }
  throw new Error(`service did not become healthy at ${url}`);
}

function isLocalUrl(value: string): boolean {
  const url = new URL(value);
  return ["localhost", "127.0.0.1", "0.0.0.0"].includes(url.hostname);
}

function resolvePort(value: string, fallback: number): number {
  const url = new URL(value);
  return url.port ? Number(url.port) : fallback;
}

async function prompt(label: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(label)).trim();
  } finally {
    rl.close();
  }
}

async function promptWithDefault(
  label: string,
  fallback: string,
): Promise<string> {
  const answer = await prompt(`${label} [${fallback}]: `);
  return answer || fallback;
}

async function promptRequired(
  label: string,
  fallback?: string,
): Promise<string> {
  const answer = fallback
    ? await promptWithDefault(label, fallback)
    : await prompt(`${label}: `);
  if (!answer) throw new Error(`${label} is required`);
  return answer;
}

async function promptSecretRequired(label: string): Promise<string> {
  const answer = await promptSecretOptional(label);
  if (!answer) throw new Error("secret value is required");
  return answer;
}

async function promptSecretOptional(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return prompt(label);
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

async function confirm(label: string, fallback: boolean): Promise<boolean> {
  const suffix = fallback ? "Y/n" : "y/N";
  const answer = (await prompt(`${label} [${suffix}]: `)).trim().toLowerCase();
  if (!answer) return fallback;
  return answer === "y" || answer === "yes";
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
