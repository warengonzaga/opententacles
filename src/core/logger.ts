import { LogEngine, LogMode } from "@wgtechlabs/log-engine";

/**
 * Pino-compatible logger surface backed by `@wgtechlabs/log-engine`.
 *
 * log-engine is a global singleton without `.child()` bindings, so this shim
 * provides:
 *  - the pino call shape `logger.info({ obj }, "msg")` or `logger.info("msg")`
 *  - `.child(bindings)` that returns a new Logger which merges bindings into
 *    every subsequent log call's context
 */
export interface Logger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  debug(msg: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  info(msg: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  warn(msg: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  error(msg: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

type Level = "debug" | "info" | "warn" | "error";

const MODE_BY_LEVEL: Record<string, LogMode> = {
  debug: LogMode.DEBUG,
  info: LogMode.INFO,
  warn: LogMode.WARN,
  error: LogMode.ERROR,
  silent: LogMode.SILENT,
};

function serializeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return { message: value.message, stack: value.stack, name: value.name };
  }
  return value;
}

function serializeContext(ctx: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) out[k] = serializeValue(v);
  return out;
}

class ShimLogger implements Logger {
  constructor(private readonly bindings: Record<string, unknown>) {}

  private emit(level: Level, a: unknown, b?: string): void {
    let msg: string;
    let ctx: Record<string, unknown>;
    if (typeof a === "string") {
      msg = a;
      ctx = { ...this.bindings };
    } else if (a && typeof a === "object") {
      msg = b ?? "";
      ctx = { ...this.bindings, ...(a as Record<string, unknown>) };
    } else {
      msg = b ?? String(a ?? "");
      ctx = { ...this.bindings };
    }
    const payload = serializeContext(ctx);
    if (Object.keys(payload).length === 0) {
      LogEngine[level](msg);
    } else {
      LogEngine[level](msg, payload);
    }
  }

  debug(a: unknown, b?: string): void { this.emit("debug", a, b); }
  info(a: unknown, b?: string): void { this.emit("info", a, b); }
  warn(a: unknown, b?: string): void { this.emit("warn", a, b); }
  error(a: unknown, b?: string): void { this.emit("error", a, b); }

  child(bindings: Record<string, unknown>): Logger {
    return new ShimLogger({ ...this.bindings, ...bindings });
  }
}

export interface CreateLoggerOptions {
  level: string;
  format?: "text" | "json";
}

export function createLogger(opts: CreateLoggerOptions | string): Logger {
  const normalized: CreateLoggerOptions =
    typeof opts === "string" ? { level: opts } : opts;
  const mode = MODE_BY_LEVEL[normalized.level.toLowerCase()] ?? LogMode.INFO;
  const format = normalized.format ?? "text";

  if (format === "json") {
    // log-engine has no native JSON format — emit structured JSON via a
    // custom output handler and suppress its default console formatter.
    LogEngine.configure({
      mode,
      suppressConsoleOutput: true,
      outputHandler: (level, message, data) => {
        const line = JSON.stringify({
          ts: new Date().toISOString(),
          level: String(level).toLowerCase(),
          msg: message,
          ...(data && typeof data === "object" ? (data as Record<string, unknown>) : {}),
        });
        process.stdout.write(line + "\n");
      },
    });
  } else {
    LogEngine.configure({ mode });
  }

  return new ShimLogger({});
}

/** Silent logger for tests. Reconfigures the global log-engine to SILENT. */
export function createSilentLogger(): Logger {
  LogEngine.configure({ mode: LogMode.SILENT });
  return new ShimLogger({});
}
