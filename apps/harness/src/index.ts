import { createServer } from "node:http";
import { CopilotClient } from "@github/copilot-sdk";
import { requireKey } from "../../../packages/core/src/crypto.ts";
import { connectDatabase } from "../../../packages/core/src/db.ts";
import { migrate } from "../../../packages/core/src/migrations.ts";
import { HarnessWorker } from "./worker.ts";

const token = process.env.COPILOT_GITHUB_TOKEN;
if (!token)
  throw new Error("COPILOT_GITHUB_TOKEN is required by the harness service");

const db = connectDatabase();
await migrate(db);
await db`UPDATE jobs SET status='failed', error='harness restarted; coding turn was not retried', completed_at=now(), lease_until=null WHERE kind='prompt' AND status='claimed'`;
const client = new CopilotClient({
  gitHubToken: token,
  useLoggedInUser: false,
  logLevel: "warning",
});
await client.start();
const worker = new HarnessWorker(
  db,
  client,
  `harness-${crypto.randomUUID()}`,
  requireKey(
    process.env.OPENTENTACLES_ENCRYPTION_KEY,
    "OPENTENTACLES_ENCRYPTION_KEY",
  ),
);
const server = createServer((request, response) => {
  response.writeHead(request.url === "/health" ? 200 : 404, {
    "content-type": "application/json",
  });
  response.end(
    request.url === "/health" ? '{"ok":true}' : '{"error":"not found"}',
  );
});
server.listen(Number(process.env.PORT ?? 3002));

const shutdown = async () => {
  worker.stop();
  server.close();
  await client.stop();
  await db.end();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
await worker.run();
