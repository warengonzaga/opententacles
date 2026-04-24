import pino from "pino";

export function createLogger(level: string) {
  const isProd = Bun.env.NODE_ENV === "production";
  return pino({
    level,
    ...(isProd
      ? {}
      : {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "HH:MM:ss" },
          },
        }),
  });
}

export type { Logger } from "pino";
