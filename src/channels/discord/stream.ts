const DISCORD_MAX_LEN = 2000;
const DEFAULT_FLUSH_MS = 500;

export interface EditableMessage {
  edit(content: string): Promise<unknown>;
}

export interface OverflowSink {
  reply(content: string): Promise<EditableMessage>;
}

export interface StreamBufferOptions {
  flushMs?: number;
  maxLen?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
}

export class DiscordStreamBuffer {
  private buffer = "";
  private messages: EditableMessage[] = [];
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private readonly flushMs: number;
  private readonly maxLen: number;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<StreamBufferOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<StreamBufferOptions["clearTimer"]>;

  constructor(
    initial: EditableMessage,
    private readonly sink: OverflowSink,
    opts: StreamBufferOptions = {},
  ) {
    this.messages.push(initial);
    this.flushMs = opts.flushMs ?? DEFAULT_FLUSH_MS;
    this.maxLen = opts.maxLen ?? DISCORD_MAX_LEN;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t));
  }

  append(chunk: string): void {
    if (!chunk) return;
    this.buffer += chunk;
    this.scheduleFlush();
  }

  async finalize(): Promise<void> {
    if (this.pendingTimer) {
      this.clearTimer(this.pendingTimer);
      this.pendingTimer = null;
    }
    await this.flush();
  }

  private scheduleFlush(): void {
    if (this.pendingTimer) return;
    this.pendingTimer = this.setTimer(() => {
      this.pendingTimer = null;
      void this.flush();
    }, this.flushMs);
  }

  private async flush(): Promise<void> {
    if (this.flushing) {
      await this.flushing;
      if (!this.buffer) return;
    }
    if (!this.buffer) return;

    this.flushing = this.doFlush();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  private async doFlush(): Promise<void> {
    const chunks = splitForDiscord(this.buffer, this.maxLen);
    this.buffer = "";

    for (const [i, chunk] of chunks.entries()) {
      const target = this.messages.at(-1);
      if (target === undefined) break;
      if (i > 0) {
        const next = await this.sink.reply(chunk);
        this.messages.push(next);
      } else {
        await target.edit(chunk);
      }
    }
  }

  messageCount(): number {
    return this.messages.length;
  }
}

export function splitForDiscord(
  text: string,
  maxLen = DISCORD_MAX_LEN,
): string[] {
  if (text.length <= maxLen) return [text];
  const out: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    const slice = remaining.slice(0, maxLen);
    const breakAt = findBreakPoint(slice);
    out.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt);
  }
  if (remaining.length > 0) out.push(remaining);
  return out;
}

function findBreakPoint(slice: string): number {
  const newline = slice.lastIndexOf("\n");
  if (newline > slice.length * 0.5) return newline + 1;
  const space = slice.lastIndexOf(" ");
  if (space > slice.length * 0.5) return space + 1;
  return slice.length;
}
