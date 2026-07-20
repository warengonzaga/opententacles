import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type StoredState = {
  baseUrl: string;
  sessionCookie?: string;
  lastSessionId?: string;
};

export const stateDir = join(homedir(), ".opententacles");
export const statePath = join(stateDir, "cli.json");

export class ApiClient {
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

export function normalizeBaseUrl(value?: string): string {
  return new URL(value ?? "http://localhost:3000").toString();
}

export async function saveState(state: StoredState): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function readSessionCookie(headers: Headers): string | undefined {
  const withSetCookies = headers as Headers & { getSetCookie?: () => string[] };
  const values = withSetCookies.getSetCookie?.() ?? [];
  const combined = values.length
    ? values.join(";")
    : (headers.get("set-cookie") ?? "");
  const match = combined.match(/ot_session=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}
