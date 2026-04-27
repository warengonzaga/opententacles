import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { openDb } from "../../src/core/db.ts";
import { MemoryStore } from "../../src/core/memory.ts";

function makeDb(): Database {
  // In-memory DB with migrations applied.
  return openDb(":memory:");
}

describe("MemoryStore", () => {
  test("round-trip: append and load turns in chronological order", () => {
    const store = new MemoryStore(makeDb());

    store.appendTurn("u1", "discord", "user", "hello");
    store.appendTurn("u1", "discord", "assistant", "hi there");
    store.appendTurn("u1", "discord", "user", "how are you?");

    const turns = store.loadRecent("u1");
    expect(turns).toHaveLength(3);
    expect(turns[0]!.role).toBe("user");
    expect(turns[0]!.content).toBe("hello");
    expect(turns[1]!.role).toBe("assistant");
    expect(turns[2]!.content).toBe("how are you?");
  });

  test("cross-channel: turns from discord and telegram share the same owner history", () => {
    const store = new MemoryStore(makeDb());

    store.appendTurn("u1", "discord", "user", "discord msg");
    store.appendTurn("u1", "telegram", "assistant", "telegram reply");

    const turns = store.loadRecent("u1");
    expect(turns).toHaveLength(2);
    expect(turns[0]!.channel).toBe("discord");
    expect(turns[1]!.channel).toBe("telegram");
  });

  test("different owners are isolated", () => {
    const store = new MemoryStore(makeDb());

    store.appendTurn("alice", "discord", "user", "alice msg");
    store.appendTurn("bob", "discord", "user", "bob msg");

    expect(store.loadRecent("alice")).toHaveLength(1);
    expect(store.loadRecent("alice")[0]!.content).toBe("alice msg");
    expect(store.loadRecent("bob")).toHaveLength(1);
  });

  test("respects maxTurns limit, returning most recent", () => {
    const store = new MemoryStore(makeDb(), 3);

    for (let i = 1; i <= 5; i++) {
      store.appendTurn("u1", "discord", "user", `msg ${i}`);
    }

    const turns = store.loadRecent("u1");
    expect(turns).toHaveLength(3);
    // Should be the 3 most recent, in chronological order
    expect(turns[0]!.content).toBe("msg 3");
    expect(turns[2]!.content).toBe("msg 5");
  });

  test("empty history returns empty string from formatForInjection", () => {
    const store = new MemoryStore(makeDb());
    expect(store.formatForInjection([])).toBe("");
  });

  test("formatForInjection produces well-formed history block", () => {
    const store = new MemoryStore(makeDb());
    store.appendTurn("u1", "discord", "user", "what repos do I have?");
    store.appendTurn("u1", "discord", "assistant", "you have two repos");

    const block = store.formatForInjection(store.loadRecent("u1"));
    expect(block).toContain("--- Previous conversation history");
    expect(block).toContain("User: what repos do I have?");
    expect(block).toContain("Assistant: you have two repos");
    expect(block).toContain("--- End of history ---");
  });

  test("loadRecent returns empty array when no history exists", () => {
    const store = new MemoryStore(makeDb());
    expect(store.loadRecent("unknown-user")).toEqual([]);
  });
});
