# OpenTentacles

> GitHub Copilot, reaching into your chat apps. Discord first, Telegram next.

OpenTentacles wraps the [GitHub Copilot SDK](https://www.npmjs.com/package/@github/copilot-sdk) in a pluggable channel framework so you can talk to Copilot from places other than your editor. v1 ships a Discord DM channel; the plugin contract is designed so new channels drop into `src/channels/<name>/` with no core changes.

Built **bun-first** on TypeScript: no Node shims, uses `Bun.file`, `Bun.env`, `bun:sqlite`, and `bun test` throughout.

## Status

**v1 — early development.** DM-only, allowlist-gated, single bot-owner Copilot token.

## Requirements

- [Bun](https://bun.sh) ≥ 1.2
- A GitHub account with an active Copilot subscription (or BYOK LLM credentials — see the Copilot SDK docs)
- A Discord bot application and token

## Quickstart

```bash
git clone https://github.com/warengonzaga/opententacles.git
cd opententacles
bun install

cp .env.example .env           # fill in COPILOT_GITHUB_TOKEN, DISCORD_BOT_TOKEN
cp config.example.toml config.toml   # set your Discord user ID in the allowlist

bun run dev
```

DM the bot. Conversation memory persists per Discord user until idle timeout.

## Configuration

Two files:

- **`.env`** — secrets and runtime env (`COPILOT_GITHUB_TOKEN`, `DISCORD_BOT_TOKEN`, `LOG_LEVEL`).
- **`config.toml`** — non-secret tunables (model, enabled channels, per-channel allowlists).

Example `config.toml`:

```toml
[copilot]
model = "gpt-4.1"
idle_timeout_minutes = 30

[channels]
enabled = ["discord"]

[channels.discord]
allowlist = ["123456789012345678"]   # Discord user IDs allowed to DM the bot
```

Leave `allowlist = []` to allow anyone (not recommended while the bot shares your Copilot token).

## Architecture

```
src/
├── index.ts              entry: load config → discover channels → start them
├── registry.ts           auto-discovers channels from src/channels/*/index.ts
├── core/
│   ├── types.ts          Channel plugin contract
│   ├── config.ts         env + TOML loader, zod-validated
│   ├── copilot.ts        per-user session cache over @github/copilot-sdk
│   ├── db.ts             bun:sqlite for persistent state
│   └── logger.ts
└── channels/
    ├── discord/          v1 — DM-only Discord channel
    └── telegram/         v2 placeholder
```

### The Channel contract

```ts
export interface Channel {
  readonly name: string;
  start(ctx: ChannelContext): Promise<void>;
  stop(): Promise<void>;
}

export interface ChannelContext {
  copilot: CopilotOrchestrator;   // send(userKey, prompt, { onDelta, onIdle, onError })
  logger: Logger;
  config: unknown;                // this channel's slice of config.toml
}
```

A channel's job: take incoming chat messages from its platform, route them to `ctx.copilot.send(userKey, prompt, handler)`, and render the streamed deltas back into the platform's native UI.

### Copilot session model

One `CopilotSession` per `userKey` (Discord user ID in the Discord channel). Sessions are cached in memory, reused across messages for multi-turn memory, and evicted after `idle_timeout_minutes` of inactivity. One shared `CopilotClient` authenticates once from `COPILOT_GITHUB_TOKEN`.

## Adding a new channel

1. Create `src/channels/<name>/index.ts`.
2. Default-export an object implementing `Channel`.
3. Add `<name>` to `channels.enabled` in `config.toml`.
4. Add any channel-specific config under `[channels.<name>]`.

The registry will find it at startup. See `src/channels/discord/` as a reference implementation.

## Scripts

```bash
bun run dev         # hot-reload dev server
bun run start       # run once
bun test            # unit tests
bun run typecheck   # tsc --noEmit
```

## Roadmap

- [ ] Telegram channel (grammY)
- [ ] Slash commands: `/reset`, `/model`, `/status`
- [ ] Per-user GitHub OAuth linking
- [ ] File and image attachments
- [ ] Guild channel support (mentions, threads)
- [ ] Dockerfile + deployment guide

## License

MIT — see [LICENSE](./LICENSE).
