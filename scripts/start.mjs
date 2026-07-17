const entrypoints = {
  web: "../dist/web/index.js",
  gateway: "../dist/gateway/index.js",
  harness: "../dist/harness/index.js",
};
const entrypoint = entrypoints[process.env.OPENTENTACLES_SERVICE];
if (!entrypoint)
  throw new Error("OPENTENTACLES_SERVICE must be web, gateway, or harness");
await import(entrypoint);
