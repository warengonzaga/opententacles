import { CopilotClient } from "@github/copilot-sdk";

const [
  owner,
  repo,
  branch = "main",
  prompt = "Reply with cloud session ready.",
] = process.argv.slice(2);
const token = process.env.COPILOT_GITHUB_TOKEN;
if (!owner || !repo || !token) {
  throw new Error(
    "usage: COPILOT_GITHUB_TOKEN=... bun apps/harness/src/spike.ts OWNER REPOSITORY [BRANCH] [PROMPT]",
  );
}

const client = new CopilotClient({
  gitHubToken: token,
  useLoggedInUser: false,
});
await client.start();
try {
  let remoteUrl: string | undefined;
  let resolveReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const session = await client.createSession({
    streaming: true,
    cloud: { repository: { owner, name: repo, branch } },
    onPermissionRequest: () => ({
      kind: "reject",
      feedback: "spike does not grant side effects",
    }),
    onEvent: (event) => {
      if (
        event.type === "session.start" &&
        event.data.producer === "copilot-agent"
      )
        resolveReady?.();
      if (event.type === "session.info" && event.data.infoType === "remote")
        remoteUrl = event.data.url;
      if (event.type === "assistant.message_delta")
        process.stdout.write(event.data.deltaContent);
    },
  });
  await Promise.race([
    ready,
    new Promise((resolve) => setTimeout(resolve, 60_000)).then(() =>
      Promise.reject(new Error("cloud worker did not start")),
    ),
  ]);
  console.log(`\nMission Control: ${remoteUrl ?? "pending"}`);
  await session.sendAndWait({ prompt }, 30 * 60_000);
  const listed = await client.listSessions();
  if (!listed.some((item) => item.sessionId === session.sessionId))
    throw new Error("created session missing from SDK list");
  await session.abort();
  await session.disconnect();
  const resumed = await client.resumeSession(session.sessionId, {
    onPermissionRequest: () => ({ kind: "reject", feedback: "spike cleanup" }),
  });
  await resumed.disconnect();
} finally {
  await client.stop();
}
