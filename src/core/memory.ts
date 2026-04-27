import type { Database } from "bun:sqlite";

export interface Turn {
  role: "user" | "assistant";
  content: string;
  channel: string;
  createdAt: number;
}

const MAX_TURNS_DEFAULT = 50;

type TurnRow = {
  id: number;
  role: string;
  content: string;
  channel: string;
  created_at: number;
};

function isValidRole(v: string): v is "user" | "assistant" {
  return v === "user" || v === "assistant";
}

/**
 * SQLite-backed conversation turn store.
 *
 * Turns are stored by raw `ownerId` (not channel-scoped) so that history is
 * shared across channels — Discord and Telegram sessions for the same owner
 * see the same conversation history on cold start.
 *
 * The `channel` column is metadata only — used for debugging and future
 * compactor context, not for partitioning reads.
 */
export class MemoryStore {
  constructor(
    private readonly db: Database,
    private readonly maxTurns = MAX_TURNS_DEFAULT,
  ) {}

  appendTurn(
    ownerId: string,
    channel: string,
    role: "user" | "assistant",
    content: string,
  ): void {
    const createdAt = Date.now();
    this.db.run(
      "INSERT INTO conversation_turns (owner_id, channel, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
      [ownerId, channel, role, content, createdAt],
    );
    // Compact: keep only the most recent maxTurns rows per owner to bound disk usage.
    this.db.run(
      `DELETE FROM conversation_turns
       WHERE owner_id = ?
         AND id NOT IN (
           SELECT id FROM conversation_turns
           WHERE owner_id = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?
         )`,
      [ownerId, ownerId, this.maxTurns],
    );
  }

  /**
   * Returns up to `maxTurns` most recent turns for the owner, in chronological
   * order (oldest → newest), ready for injection into a system message.
   */
  loadRecent(ownerId: string): Turn[] {
    const rows = this.db
      .query<TurnRow, [string, number]>(
        `SELECT id, role, content, channel, created_at
         FROM conversation_turns
         WHERE owner_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(ownerId, this.maxTurns);

    return rows.reverse().flatMap((r) => {
      if (!isValidRole(r.role)) return [];
      return [
        {
          role: r.role,
          content: r.content,
          channel: r.channel,
          createdAt: r.created_at,
        },
      ];
    });
  }

  /**
   * Formats turns into a history block suitable for prepending to a Copilot
   * system message on cold-start session creation.
   */
  formatForInjection(turns: Turn[]): string {
    if (turns.length === 0) return "";
    return [
      "--- Previous conversation history (for context) ---",
      JSON.stringify({
        turns: turns.map((t) => ({ role: t.role, content: t.content })),
      }),
      "--- End of history ---",
    ].join("\n");
  }
}
