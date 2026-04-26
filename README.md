# OpenTentacles 🐙

> Give GitHub Copilot arms.

**OpenTentacles is a GitHub-native AI agent framework for personal OSS maintainers.** It turns GitHub Copilot from a chat tool you talk to in a browser tab into a partner that reaches out everywhere your open-source work happens — Discord, Telegram, and beyond.

One Copilot brain. Many tentacles.

> 📖 See [`VISION.md`](./docs/VISION.md) for the full project vision and decision log.

---

## Status

**v1 — early development.** Solo-use, Discord-first, single bot-owner Copilot token.

Currently private while the framework hardens. Will be made public when v1 is ready.

---

## Why this exists

GitHub Copilot is brilliant inside vscode and on the web — but the moment you leave the editor, it's gone. OSS maintenance doesn't only happen in vscode. It happens on Discord with contributors, on Telegram with collaborators, on your phone, mid-conversation. The full Copilot experience is boxed.

OpenTentacles unboxes it. It's the partner that shows up where you already are, remembers what you've worked on, and helps you maintain and build OSS — everywhere.

GitHub's mascot is the Octocat. Octocats have tentacles. So OpenTentacles gives Copilot its tentacles.

---

## What it is

- 🧠 **Brain:** GitHub Copilot SDK ([`@github/copilot-sdk`](https://www.npmjs.com/package/@github/copilot-sdk))
- 🐙 **Tentacles:** pluggable channels (Discord first, Telegram next, more later)
- 🔧 **Hands:** GitHub-native tools — `gh` CLI, Octokit, MCP
- 💾 **Memory:** central `bun:sqlite` store, channel-tagged, cross-channel recall
- 🤝 **Behavior:** acts when certain, confirms when not. Goal = full autonomy.
- 🔒 **Audit:** every action leaves a receipt

## What it is NOT

- Not a multi-provider AI router — the brain is **GitHub Copilot, by design**
- Not a replacement for Copilot in vscode, on the web, or on mobile
- Not a generic agent SDK
- Not a hosted SaaS — **self-host first**
- Not a general AI assistant — **OSS maintainers, specifically**

---

## Requirements

- [Bun](https://bun.sh) ≥ 1.2
- A GitHub account with an active **Copilot subscription**
- A Discord bot application and token (for v1)

---

## Quickstart

```bash
git clone https://github.com/warengonzaga/opententacles.git
cd opententacles
bun install

cp .env.example .env                  # fill in COPILOT_GITHUB_TOKEN, DISCORD_BOT_TOKEN
cp config.example.toml config.toml    # set your Discord user ID in the allowlist

bun run dev
```

DM the bot. Conversation memory persists per user, across sessions, across channels.

---

## Configuration

Two files:

- **`.env`** — secrets and runtime env (`COPILOT_GITHUB_TOKEN`, `DISCORD_BOT_TOKEN`, `LOG_LEVEL`)
- **`config.toml`** — non-secret tunables (model, enabled channels, per-channel allowlists, HTTP port for webhook-based channels)

Example `config.toml`:

```toml
[copilot]
model = "gpt-4.1"
idle_timeout_minutes = 30

[http]
port = 3000              # only used if a webhook-based channel is enabled

[channels]
enabled = ["discord"]

[channels.discord]
allowlist = ["123456789012345678"]   # Discord user IDs allowed to DM the bot
```

Leave `allowlist = []` to allow anyone (not recommended — the bot uses your Copilot subscription).

---

## Architecture

```
src/
├── index.ts              entry: load config → discover channels → start them
├── registry.ts           auto-discovers channels from src/channels/*/index.ts
├── core/
│   ├── types.ts          Channel + ChannelContext contracts
│   ├── config.ts         env + TOML loader, zod-validated
│   ├── copilot.ts        per-user session cache over @github/copilot-sdk
│   ├── heartware.ts      the agent loop (inspired by TinyClaw / OpenClaw)
│   ├── memory.ts         channel-tagged sqlite memory + audit
│   ├── http-host.ts      lazy HTTP host for webhook-based channels
│   ├── db.ts             bun:sqlite for persistent state
│   └── logger.ts
└── channels/
    ├── discord/          v1 — DM-only Discord channel (long-running)
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
  http: HttpHost;                 // lazy — only boots if a channel registers a route
}
```

The contract supports both shapes:

- **Long-running channels** (Discord, Telegram bot, IRC, Matrix) — open a connection in `start()`, listen forever. Ignore `ctx.http`.
- **Webhook channels** (Slack, WhatsApp, future GitHub-App-style) — register routes via `ctx.http.post(...)` in `start()`. The HTTP server boots on first registration.

A user running Discord-only never sees the HTTP server start. A user adding Slack later doesn't refactor anything.

### Memory model

Central `bun:sqlite` store with cross-channel recall:

| Table | Purpose |
|---|---|
| `identities` | links Discord/Telegram/etc. user IDs to one GitHub login |
| `conversations` | per identity, per channel, with channel tag |
| `facts` | per identity, channel-agnostic |
| `audit` | every action the agent took, with channel and receipt |

Ask the agent on Telegram *"do you remember what we discussed?"* and it can answer *"yes — on Discord on Tuesday, you mentioned the rate-limiter bug in `wgtechlabs/clean-commit`."*

### Autonomy

- **v1:** acts on high-confidence tasks, confirms when uncertain
- **Goal:** full autonomy as tools and confidence harden
- **Always:** every action leaves a receipt in the audit log

---

## Adding a new channel

1. Create `src/channels/<name>/index.ts`.
2. Default-export an object implementing `Channel`.
3. Add `<name>` to `channels.enabled` in `config.toml`.
4. Add any channel-specific config under `[channels.<name>]`.

The registry will find it at startup. See `src/channels/discord/` as a reference implementation for long-running channels. A webhook channel reference will land alongside the first webhook integration.

**Official vs community channels:**
- **Official** — built into this repo, maintained by me, ships with the Docker image (Discord, Telegram, …).
- **Community** — separate repo, installed as a plugin, community-maintained.

---

## Scripts

```bash
bun run dev         # hot-reload dev server
bun run start       # run once
bun test            # unit tests
bun run typecheck   # tsc --noEmit
```

---

## Hosting

**Self-host first.** Docker is the official deploy target. **Railway** is the recommended platform.

- [ ] Dockerfile + `docker compose` (planned)
- [ ] Railway template (planned)

---

## Roadmap

The roadmap is **"which tentacle next,"** not "which feature next."

**Phase 0 — Framework hardening**
- [x] Channel contract (long-running shape)
- [ ] Channel contract (webhook shape via lazy `HttpHost`)
- [ ] Heartware agent loop
- [ ] Channel-tagged memory + audit

**Phase 1 — Official channels**
- [ ] Discord DM
- [ ] Telegram DM (grammY)
- [ ] Slash commands: `/reset`, `/model`, `/status`
- [ ] File and image attachments
- [ ] Guild channel support (mentions, threads)

**Phase 2 — Community channels** (plugins)
- WhatsApp, Slack, Matrix, IRC, Mastodon, Bluesky — the framework makes channels cheap; the community provides the long tail.

---

## 🐛 Issues

Please report any issues and bugs by [creating a new issue here](https://github.com/warengonzaga/opententacles/issues/new/choose), also make sure you're reporting an issue that doesn't exist. Any help to improve the project would be appreciated. Thanks! 🙏✨

## 🙏 Sponsor

Like this project? Leave a star! ⭐⭐⭐⭐⭐

Want to support my work and get some perks? [Become a sponsor](https://github.com/sponsors/warengonzaga)! 💖

Or, you just love what I do? [Buy me a coffee](https://buymeacoffee.com/warengonzaga)! ☕

Recognized my open-source contributions? [Nominate me](https://stars.github.com/nominate) as GitHub Star! 💫

## 📋 Code of Conduct

Read the project's [code of conduct](https://github.com/warengonzaga/opententacles/blob/main/CODE_OF_CONDUCT.md).

## 📃 License

This project is licensed under [GNU General Public License v3.0](https://www.gnu.org/licenses/gpl-3.0.html).

## 💡 Inspired by

- [OpenClaw](https://github.com/openclaw/openclaw) — generic AI agent platform
- [TinyClaw](https://github.com/warengonzaga/tinyclaw) — lightweight heartware reference

OpenTentacles is **a different flavor** — GitHub-focused, OSS-maintainer-focused, Copilot-brained. Not an alternative to OpenClaw; a sibling with a different mission. See [`VISION.md`](./docs/VISION.md) for the full positioning.

## 📝 Author

This project is created by [Waren Gonzaga](https://github.com/warengonzaga), with the help of awesome [contributors](https://github.com/warengonzaga/opententacles/graphs/contributors).

[![contributors](https://contrib.rocks/image?repo=warengonzaga/opententacles)](https://github.com/warengonzaga/opententacles/graphs/contributors)

---

💻💖☕ by [Waren Gonzaga](https://warengonzaga.com) | [YHWH](https://www.youtube.com/watch?v=VOZbswniA-g) 🙏 - Without _Him_, none of this exists, _even me_.