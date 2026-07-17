# OpenTentacles

OpenTentacles is a self-hosted, single-owner control plane for GitHub-hosted Copilot cloud sessions. It has a password-protected web dashboard, an owner-only Discord DM gateway, a durable Copilot harness, and PostgreSQL.

## Architecture

One Docker image runs three independently restartable Railway services selected by `OPENTENTACLES_SERVICE`:

| Service | Responsibility | Required secrets |
| --- | --- | --- |
| `web` | Dashboard, session creation, SSE, approvals, settings | database, encryption/session keys |
| `gateway` | Owner-only Discord DMs and durable delivery | database, encryption key |
| `harness` | Copilot SDK cloud sessions and durable jobs | database, encryption key, `COPILOT_GITHUB_TOKEN` |
| PostgreSQL | State, queue, events, audit, encrypted settings | Railway-managed |

The harness is the only service with the Copilot token. It creates GitHub-hosted cloud sessions through `@github/copilot-sdk`, waits for the remote `copilot-agent` before the first prompt, and persists the Mission Control URL.

## Local development

```sh
bun install
cp .env.example .env
bun run migrate
OPENTENTACLES_SERVICE=web bun run scripts/start.ts
```

Use Node.js LTS to run packaged services; Bun is the install, test, typecheck, and build toolchain.

## Railway

Create one Railway project with a PostgreSQL service and three services from this repository. Set `OPENTENTACLES_SERVICE` to `web`, `gateway`, and `harness` respectively. Give all three the same `DATABASE_URL`, `OPENTENTACLES_APP_URL`, `OPENTENTACLES_ENCRYPTION_KEY`, and `OPENTENTACLES_SESSION_KEY`. Set `COPILOT_GITHUB_TOKEN` only on `harness`; it needs a fine-grained token with Copilot Requests and access to the repositories it controls.

Expose a public domain only for `web`. Configure Discord through the authenticated dashboard, where credentials are encrypted with AES-256-GCM before storage.

## Limits and non-goals

The deployment supports one owner. Sandbox-local reads, writes, and tests are allowed; GitHub and external side effects wait for an approval. There is no multi-user access, BYOK, local stdio MCP, Telegram/WhatsApp/guild channels, Redis, workflow engine, local runner, automatic push/merge, or scheduler loop.
