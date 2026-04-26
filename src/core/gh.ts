import type { Logger } from "./logger.ts";

const GH_TOKEN_TIMEOUT_MS = 5_000;

export async function resolveGhToken(logger: Logger): Promise<string | null> {
  try {
    const proc = Bun.spawn(["gh", "auth", "token"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeout = setTimeout(() => proc.kill(), GH_TOKEN_TIMEOUT_MS);
    const exit = await proc.exited;
    clearTimeout(timeout);

    if (exit !== 0) {
      const stderr = await new Response(proc.stderr).text();
      logger.warn(
        { exit, stderr: stderr.trim() },
        "gh auth token failed; ensure `gh auth login` has been run",
      );
      return null;
    }

    const token = (await new Response(proc.stdout).text()).trim();
    if (!token) {
      logger.warn("gh auth token returned empty output");
      return null;
    }
    return token;
  } catch (err) {
    logger.warn(
      { err },
      "could not invoke `gh`; install GitHub CLI to enable GitHub MCP",
    );
    return null;
  }
}
