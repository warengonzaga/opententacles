#!/usr/bin/env bun
import { version } from "../package.json";

function showHelp(): void {
  console.log(
    `  OpenTentacles v${version}
  A GitHub-native AI agent framework.

  Usage
    opententacles <command>

  Commands
    setup    Interactive setup wizard
    start    Start the agent
    purge    Wipe all data for a fresh install

  Options
    --version, -v   Print version
    --help, -h      Show this help`.trim(),
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "setup": {
      const { setupCommand } = await import("./setup.ts");
      await setupCommand();
      break;
    }
    case "start": {
      const { startBot } = await import("./index.ts");
      await startBot();
      break;
    }
    case "purge": {
      const { purgeCommand } = await import("./purge.ts");
      await purgeCommand(args.slice(1));
      break;
    }
    case "--version":
    case "-v":
      console.log(version);
      break;
    case "--help":
    case "-h":
    case undefined:
      showHelp();
      break;
    default:
      console.error(`  Unknown command: ${command}\n`);
      showHelp();
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
