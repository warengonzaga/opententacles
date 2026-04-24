import { describe, expect, test } from "bun:test";
import {
  DiscordStreamBuffer,
  splitForDiscord,
  type EditableMessage,
  type OverflowSink,
} from "../../../src/channels/discord/stream.ts";

function makeFakeMessage() {
  const edits: string[] = [];
  const msg: EditableMessage = {
    edit: async (content: string) => {
      edits.push(content);
      return msg;
    },
  };
  return { msg, edits };
}

function makeFakeSink() {
  const replies: string[] = [];
  const allEdits: Array<string[]> = [];
  const sink: OverflowSink = {
    reply: async (content: string) => {
      replies.push(content);
      const edits: string[] = [];
      allEdits.push(edits);
      return {
        edit: async (c: string) => {
          edits.push(c);
        },
      };
    },
  };
  return { sink, replies, allEdits };
}

class ManualTimer {
  private pending: Array<{ fn: () => void; at: number }> = [];
  public clock = 0;
  readonly setTimer = (fn: () => void, ms: number) => {
    const entry = { fn, at: this.clock + ms };
    this.pending.push(entry);
    return entry as unknown as ReturnType<typeof setTimeout>;
  };
  readonly clearTimer = (t: ReturnType<typeof setTimeout>) => {
    this.pending = this.pending.filter((e) => (e as unknown) !== t);
  };
  async advance(ms: number) {
    this.clock += ms;
    const due = this.pending.filter((e) => e.at <= this.clock);
    this.pending = this.pending.filter((e) => e.at > this.clock);
    for (const e of due) e.fn();
    await Promise.resolve();
    await Promise.resolve();
  }
}

describe("splitForDiscord", () => {
  test("returns input unchanged when under the limit", () => {
    expect(splitForDiscord("hello", 2000)).toEqual(["hello"]);
  });

  test("prefers newline boundaries in the second half", () => {
    const a = "a".repeat(80);
    const b = "b".repeat(80);
    const text = `${a}\n${b}`;
    const parts = splitForDiscord(text, 100);
    expect(parts.length).toBe(2);
    expect(parts[0]!.endsWith("\n")).toBe(true);
  });

  test("falls back to space boundary when no newline", () => {
    const text = "word ".repeat(50);
    const parts = splitForDiscord(text, 100);
    expect(parts.length).toBeGreaterThan(1);
    for (let i = 0; i < parts.length - 1; i++) {
      expect(parts[i]!.length).toBeLessThanOrEqual(100);
    }
  });

  test("hard-cuts if no natural boundary exists", () => {
    const text = "x".repeat(250);
    const parts = splitForDiscord(text, 100);
    expect(parts.length).toBe(3);
    expect(parts[0]!.length).toBe(100);
    expect(parts[2]!.length).toBe(50);
  });
});

describe("DiscordStreamBuffer", () => {
  test("debounces edits — no flush before flushMs elapses", async () => {
    const timer = new ManualTimer();
    const { msg, edits } = makeFakeMessage();
    const { sink } = makeFakeSink();
    const buf = new DiscordStreamBuffer(msg, sink, {
      flushMs: 500,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    buf.append("hel");
    buf.append("lo");
    await timer.advance(100);
    expect(edits).toEqual([]);

    await timer.advance(500);
    expect(edits).toEqual(["hello"]);
  });

  test("finalize flushes any remaining buffered content synchronously", async () => {
    const { msg, edits } = makeFakeMessage();
    const { sink } = makeFakeSink();
    const buf = new DiscordStreamBuffer(msg, sink, { flushMs: 1_000 });
    buf.append("done");
    await buf.finalize();
    expect(edits).toEqual(["done"]);
  });

  test("spills into overflow replies when content exceeds maxLen", async () => {
    const { msg, edits } = makeFakeMessage();
    const { sink, replies } = makeFakeSink();
    const buf = new DiscordStreamBuffer(msg, sink, { flushMs: 100, maxLen: 50 });

    buf.append("a".repeat(120));
    await buf.finalize();

    expect(edits.length).toBeGreaterThanOrEqual(1);
    expect(replies.length).toBeGreaterThanOrEqual(1);
    const total = edits.join("") + replies.join("");
    expect(total.replace(/\s/g, "").length).toBeGreaterThanOrEqual(120);
    expect(buf.messageCount()).toBeGreaterThan(1);
  });
});
