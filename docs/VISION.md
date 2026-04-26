# Vision

> Give GitHub Copilot arms.

OpenTentacles is a **GitHub-native AI agent framework for personal OSS maintainers**. It turns GitHub Copilot from a chat tool you talk to in a browser tab into a partner that reaches out everywhere your open-source work happens.

This document is the project's north star. If a decision conflicts with this document, this document wins until it's deliberately updated.

---

## Why this exists

I maintain open-source projects. GitHub Copilot is brilliant inside vscode and on the web — but the moment I leave the editor, it's gone. My OSS work doesn't only happen in vscode. It happens on Discord, Telegram, my phone, my couch, mid-conversation with a contributor. The GitHub mobile app's Copilot integration is weak. There's no Copilot in my chat apps. The full-featured Copilot experience is boxed.

I don't want a tool that answers questions when I open it. I want a **partner** that shows up where I already am, remembers what we've worked on, and helps me maintain and build OSS — everywhere.

GitHub's mascot is the Octocat. Octocats have tentacles. So OpenTentacles gives Copilot its tentacles: pluggable channels that reach into Discord, Telegram, and beyond, all wired to a single Copilot brain.

---

## What it is

**OpenTentacles is a GitHub-native AI agent framework that brings Copilot to every place open-source work happens.**

The framework is the product. Channels are how we prove the framework works.

---

## What it is NOT

- ❌ Not a multi-provider AI router. The brain is **GitHub Copilot, by design**.
- ❌ Not a replacement for Copilot in vscode, on the web, or on mobile.
- ❌ Not a generic agent SDK like LangChain. It's opinionated and GitHub-shaped.
- ❌ Not a no-code agent builder.
- ❌ Not a hosted SaaS. **Self-host first.**
- ❌ Not a general AI assistant. **OSS maintainers, specifically.**

If a feature would push us toward any of the above, it doesn't belong here.

---

## Who it's for

**Solo OSS maintainers.** People like me, who run a handful of projects, live across multiple chat apps, and want a real partner — not another tab to babysit.

v1 assumes one user, one bot, one Copilot subscription. That's the point. It's personal.

---

## The thesis

Four pillars, in order:

1. **GitHub-native.** The brain is GitHub Copilot. The tools are `gh` CLI, Octokit, and MCP. Identity is GitHub. Distribution targets the GitHub ecosystem.
2. **Copilot-brained.** No multi-provider abstraction. Locked to `@github/copilot-sdk`. The `CopilotClientLike` seam exists only for tests, not for swapping providers.
3. **Channel-tentacled.** Channels are pluggable. Each channel is a folder under `src/channels/`. The framework auto-discovers them. New channel = new tentacle, no core changes.
4. **Partner, not tool.** The agent has memory across sessions and channels, takes action on your behalf when it's confident, confirms when it isn't, and leaves an audit trail for everything it does.

---

## Architecture pillars

### Heartware (the agent loop)

OpenTentacles has its own heartware — the agent loop that decides, plans, calls tools, and acts. It's **inspired by TinyClaw and OpenClaw** but implemented for this project's GitHub-native focus. A shared `heartware` library may be extracted later; for now, it lives here.

### Channel framework

Channels implement a single contract:

```ts
export interface Channel {
  readonly name: string;
  start(ctx: ChannelContext): Promise<void>;
  stop(): Promise<void>;
}
```

The contract supports two channel shapes:

- **Long-running** (Discord, Telegram bot, IRC, Matrix) — open a connection in `start()`, listen forever.
- **Webhook** (Slack, WhatsApp, future GitHub-App-style channels) — register routes via `ctx.http` in `start()`. The framework's HTTP host boots lazily on first registration.

A user running Discord-only never sees the HTTP server start. A user adding Slack later doesn't refactor anything.

### Memory

Central `bun:sqlite` store, **channel-tagged**, with cross-channel recall:

- `identities` — links Discord/Telegram/etc. user IDs to one GitHub login
- `conversations` — per identity, per channel, with channel tag
- `facts` — per identity, channel-agnostic
- `audit` — every action the agent took, with channel and receipt

Result: ask the agent on Telegram *"do you remember what we discussed?"* and it can answer *"yes — on Discord on Tuesday, you mentioned the rate-limiter bug in `wgtechlabs/clean-commit`."*

Copilot SDK does not maintain durable cross-session memory. **OpenTentacles owns the memory layer.** That's the partner part of "partner, not tool."

### Storage

`bun:sqlite`. One file. Zero deps. Zero ops.

Postgres is not on the roadmap. If OpenTentacles ever grows a multi-tenant SaaS sibling, that's a separate product.

A future option — inspired by clawsweeper — is **repo-as-durable-memory**: persist decisions and audit trails as markdown in a designated repo, on top of sqlite. Optional, opt-in, not v1.

### Identity linking

Required at setup. GitHub credentials are mandatory because the whole project is built around GitHub. Each enabled channel is also linked at setup so cross-channel memory works from day one.

### Token model

**Single bot-owner Copilot token.** The maintainer's token, used for every conversation the bot has. This matches the solo use case. Per-user OAuth (each user brings their own Copilot subscription) is a possible future direction — not v1.

### Stack

- **Bun-first.** TypeScript, ESM only, `Bun.file`, `Bun.env`, `bun:sqlite`, `bun test`. No Node-only shims.
- **Self-host first.** Docker image is the official deploy target. **Railway** is the recommended hosting platform.
- **TypeScript strict** with `noUncheckedIndexedAccess`. No `any` at boundaries.

---

## Autonomy gradient

The agent's behavior matures over time:

- **v1:** Acts on high-confidence tasks. Confirms when uncertain. The user can override the threshold per-channel or per-tool.
- **Goal:** Full autonomy. As tools harden and confidence improves, the threshold for autonomous action lowers.

Every action — autonomous or confirmed — leaves a receipt in the audit log. **A partner is trusted because it shows its work.**

---

## Relationship to OpenClaw and TinyClaw

OpenTentacles is **inspired by OpenClaw and TinyClaw**, not a fork or a clone.

- **OpenClaw** is a generic AI agent platform.
- **TinyClaw** is the lightweight heartware reference.
- **OpenTentacles** is a different flavor — **GitHub-focused, OSS-maintainer-focused, Copilot-brained.** Not an alternative to OpenClaw; a sibling with a different mission.

OpenClaw skills/plugins are not a target for compatibility in v1. The mission is OSS maintenance, not generic agent capability.

---

## Roadmap framing

The roadmap is **"which tentacle next,"** not "which feature next."

**Phase 0 — Framework hardening**
Lock the `Channel` contract. Validate it against a long-running and a webhook-shaped channel before v1 freezes.

**Phase 1 — Official channels** (built and maintained in this repo)
1. Discord DM (in progress)
2. Telegram DM
3. (more, as needed for the maintainer workflow)

**Phase 2 — Community channels** (plugins, separate repos)
WhatsApp, Slack, Matrix, IRC, Mastodon, Bluesky, anything. The framework makes channels cheap; the community provides the long tail.

**Official vs community:**
- **Official** — lives in this repo, maintained by me, ships with the Docker image.
- **Community** — separate repo, installed as a plugin, marked as community-maintained.

---

## Project posture

- **Solo side project.** Maintained by [@warengonzaga](https://github.com/warengonzaga). Kept alive as long as it has purpose.
- **License:** GPLv3. Contributors sign a CLA. Dual-licensing is on the table if the project grows.
- **Self-host first.** Docker is the official deploy target. Railway is the recommended platform.
- **Private during early development.** Will be made public when v1 is ready.
- **Brand:** OpenTentacles, the Octocat-flavored cousin of OpenClaw. The tentacles metaphor is load-bearing — every channel is a tentacle reaching out from one Copilot brain.

---

## Decision log (the things that are not up for debate in v1)

1. Brain is GitHub Copilot SDK. Not swappable.
2. Storage is sqlite. Not Postgres.
3. Token model is single bot-owner. Not per-user OAuth.
4. Stack is Bun. Not Node.
5. License is GPLv3 + CLA.
6. Channel contract supports long-running and webhook shapes via lazy `HttpHost`.
7. HTTP host port defaults to `3000`, overridable in `config.toml`.
8. v1 is solo. Multi-tenant is a different product.
9. The framework is the product. Channels are the demo.
10. Partner, not tool.

---

*Last updated: when this file was committed. If reality drifts from this document, update the document — don't drift silently.*