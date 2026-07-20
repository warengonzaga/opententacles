# OpenTentacles

![Open Tentacles](https://ghrb.waren.build/banner?header=Open+Tentacles+%F0%9F%90%99&subheader=Give+GitHub+Copilot+arms.&bg=013B84-016EEA&color=ffffff)

OpenTentacles is a self-hosted, single-owner control plane for GitHub-hosted Copilot cloud sessions. It has a password-protected web dashboard, an owner-only Discord DM gateway, a durable Copilot harness, and PostgreSQL.

## 🏗️ Architecture

One Docker image runs three independently restartable Railway services selected by `OPENTENTACLES_SERVICE`:

| Service | Responsibility | Required secrets |
| --- | --- | --- |
| `web` | Dashboard, session creation, SSE, approvals, settings | database, encryption/session keys |
| `gateway` | Owner-only Discord DMs and durable delivery | database, encryption key |
| `harness` | Copilot SDK cloud sessions and durable jobs | database, encryption key, `COPILOT_GITHUB_TOKEN` |
| PostgreSQL | State, queue, events, audit, encrypted settings | Railway-managed |

The harness is the only service with the Copilot token. It creates GitHub-hosted cloud sessions through `@github/copilot-sdk`, waits for the remote `copilot-agent` before the first prompt, and persists the Mission Control URL.

See [the architecture documentation](docs/ARCHITECTURE.md) for data flows, trust boundaries, operations, and deployment prerequisites.

## 🧪 Local development

```sh
bun install
cp .env.example .env
bun run migrate
OPENTENTACLES_SERVICE=web bun run scripts/start.ts
```

Use Node.js 24 LTS to run packaged services; Bun is the install, test, typecheck, and build toolchain.

## 🚆 Railway

Create one Railway project with a PostgreSQL service and three services from this repository. Set `OPENTENTACLES_SERVICE` to `web`, `gateway`, and `harness` respectively. Give all three the same `DATABASE_URL`, `OPENTENTACLES_APP_URL`, and `OPENTENTACLES_ENCRYPTION_KEY`; set `OPENTENTACLES_SESSION_KEY` only on `web`. Set `COPILOT_GITHUB_TOKEN` only on `harness`; it needs a fine-grained token with Copilot Requests and access to the repositories it controls.

Expose a public domain only for `web`. Configure Discord through the authenticated dashboard, where credentials are encrypted with AES-256-GCM before storage.

## 🚧 Limits and non-goals

The deployment supports one owner. Sandbox-local reads, writes, and tests are allowed; GitHub and external side effects wait for an approval. There is no multi-user access, BYOK, local stdio MCP, Telegram/WhatsApp/guild channels, Redis, workflow engine, local runner, automatic push/merge, or scheduler loop.

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

## 📝 Author

This project is created by [Waren Gonzaga](https://github.com/warengonzaga), with the help of awesome [contributors](https://github.com/warengonzaga/opententacles/graphs/contributors).

[![contributors](https://contrib.rocks/image?repo=warengonzaga/opententacles)](https://github.com/warengonzaga/opententacles/graphs/contributors)

---

💻💖☕ by [Waren Gonzaga](https://warengonzaga.com) | [YHWH](https://www.youtube.com/watch?v=VOZbswniA-g) 🙏 - Without _Him_, none of this exists, _even me_.
