# OpenTentacles agents

OpenTentacles is a single-owner control plane for GitHub-hosted Copilot cloud sessions. `apps/web` authenticates and enqueues work, `apps/gateway` owns Discord DMs and deliveries, and `apps/harness` is the only service allowed to import the Copilot SDK or receive `COPILOT_GITHUB_TOKEN`. `packages/core` owns PostgreSQL state, cryptography, migrations, and queue claims.

Use Node.js LTS for production and Bun for the toolchain. Do not add local Copilot execution, Railway Sandboxes, Redis, a generic plugin registry, local stdio MCP, BYOK, multi-user accounts, automatic push/merge, or scheduler loops.

Run `bun run typecheck && bun test && bun run build` before declaring work complete. Encrypt dashboard-managed credentials with `OPENTENTACLES_ENCRYPTION_KEY`; sessions are opaque hashed cookies. Coding turns must never be retried after a harness crash. Cloud sessions must await `session.start` from `copilot-agent` before their first prompt.
