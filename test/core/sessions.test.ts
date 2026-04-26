import { describe, expect, test } from "bun:test";
import { createSilentLogger } from "../../src/core/logger.ts";
import {
  CopilotOrchestrator,
  type CopilotClientLike,
  type CopilotSessionLike,
  type OrchestratorOptions,
} from "../../src/core/copilot.ts";

const silentLogger = createSilentLogger();

class FakeSession implements CopilotSessionLike {
  public deltaHandlers: Array<(e: { data: { deltaContent: string } }) => void> = [];
  public idleHandlers: Array<() => void> = [];
  public disconnected = false;
  public sent: string[] = [];

  on(event: string, handler: (...args: any[]) => void): () => void {
    if (event === "assistant.message_delta") {
      this.deltaHandlers.push(handler);
      return () => {
        this.deltaHandlers = this.deltaHandlers.filter((h) => h !== handler);
      };
    }
    this.idleHandlers.push(handler);
    return () => {
      this.idleHandlers = this.idleHandlers.filter((h) => h !== handler);
    };
  }

  async sendAndWait({ prompt }: { prompt: string }): Promise<unknown> {
    this.sent.push(prompt);
    for (const h of this.deltaHandlers) h({ data: { deltaContent: `reply: ${prompt}` } });
    for (const h of this.idleHandlers) h();
    return undefined;
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
}

class FakeClient implements CopilotClientLike {
  public created: FakeSession[] = [];
  public stopped = false;

  async createSession(_cfg: { model?: string; streaming?: boolean; onPermissionRequest: unknown }): Promise<CopilotSessionLike> {
    const s = new FakeSession();
    this.created.push(s);
    return s;
  }

  async stop(): Promise<Error[]> {
    this.stopped = true;
    return [];
  }
}

function baseOpts(client: CopilotClientLike, overrides: Partial<OrchestratorOptions> = {}): OrchestratorOptions {
  return {
    client,
    model: "gpt-4.1",
    idleTimeoutMs: 60_000,
    permissionHandler: () => ({ decision: "approve" as const }),
    logger: silentLogger,
    ...overrides,
  };
}

describe("CopilotOrchestrator", () => {
  test("reuses the same session for the same user across messages", async () => {
    const client = new FakeClient();
    let clock = 0;
    const orch = new CopilotOrchestrator({ ...baseOpts(client), now: () => clock });

    const out: string[] = [];
    const handler = {
      onDelta: (c: string) => {
        out.push(c);
      },
      onIdle: () => {},
      onError: () => {},
    };

    await orch.send("alice", "first", handler);
    clock += 1_000;
    await orch.send("alice", "second", handler);

    expect(client.created.length).toBe(1);
    expect(client.created[0]!.sent).toEqual(["first", "second"]);
    expect(out).toEqual(["reply: first", "reply: second"]);
  });

  test("creates separate sessions per user", async () => {
    const client = new FakeClient();
    const orch = new CopilotOrchestrator(baseOpts(client));

    const noop = { onDelta: () => {}, onIdle: () => {}, onError: () => {} };
    await orch.send("alice", "hi", noop);
    await orch.send("bob", "hi", noop);

    expect(client.created.length).toBe(2);
    expect(orch.size()).toBe(2);
  });

  test("unsubscribes per-call event handlers so deltas don't leak across messages", async () => {
    const client = new FakeClient();
    const orch = new CopilotOrchestrator(baseOpts(client));

    const out: string[] = [];
    await orch.send("alice", "first", {
      onDelta: (c) => {
        out.push(`A:${c}`);
      },
      onIdle: () => {},
      onError: () => {},
    });
    await orch.send("alice", "second", {
      onDelta: (c) => {
        out.push(`B:${c}`);
      },
      onIdle: () => {},
      onError: () => {},
    });

    expect(out).toEqual(["A:reply: first", "B:reply: second"]);
    expect(client.created[0]!.deltaHandlers.length).toBe(0);
  });

  test("evictIdle drops sessions past the timeout and disconnects them", async () => {
    const client = new FakeClient();
    let clock = 0;
    const orch = new CopilotOrchestrator({ ...baseOpts(client), idleTimeoutMs: 10_000, now: () => clock });

    const noop = { onDelta: () => {}, onIdle: () => {}, onError: () => {} };
    await orch.send("alice", "hello", noop);
    expect(orch.size()).toBe(1);

    clock += 5_000;
    await orch.evictIdle();
    expect(orch.size()).toBe(1);

    clock += 10_000;
    await orch.evictIdle();
    expect(orch.size()).toBe(0);
    expect(client.created[0]!.disconnected).toBe(true);
  });

  test("propagates errors via onError and keeps the session cached", async () => {
    class BoomSession implements CopilotSessionLike {
      on(): () => void {
        return () => {};
      }
      async sendAndWait(): Promise<unknown> {
        throw new Error("boom");
      }
      async disconnect(): Promise<void> {}
    }
    const client: CopilotClientLike = {
      createSession: async () => new BoomSession(),
      stop: async () => [],
    };
    const orch = new CopilotOrchestrator(baseOpts(client));

    let caught: unknown = null;
    await orch.send("alice", "x", {
      onDelta: () => {},
      onIdle: () => {},
      onError: (e) => {
        caught = e;
      },
    });
    expect(caught).toBeInstanceOf(Error);
    expect(orch.size()).toBe(1);
  });

  test("stop() disconnects all sessions and stops the client", async () => {
    const client = new FakeClient();
    const orch = new CopilotOrchestrator(baseOpts(client));

    const noop = { onDelta: () => {}, onIdle: () => {}, onError: () => {} };
    await orch.send("alice", "hi", noop);
    await orch.send("bob", "hi", noop);
    await orch.stop();

    expect(orch.size()).toBe(0);
    expect(client.stopped).toBe(true);
    for (const s of client.created) expect(s.disconnected).toBe(true);
  });
});
