const service = process.env.OPENTENTACLES_SERVICE;
const entrypoints: Record<string, string> = {
  web: "../apps/web/src/index.ts",
  gateway: "../apps/gateway/src/index.ts",
  harness: "../apps/harness/src/index.ts",
};
const entrypoint = entrypoints[service ?? ""];
if (!entrypoint)
  throw new Error("OPENTENTACLES_SERVICE must be web, gateway, or harness");
await import(entrypoint);
