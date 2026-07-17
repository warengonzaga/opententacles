# Architecture

## Purpose and v1 boundary

OpenTentacles is a single-owner, self-hosted gateway for GitHub Copilot cloud
coding sessions. It provides a password-protected web API/dashboard and
owner-only Discord DMs backed by PostgreSQL. The harness creates the actual
coding sessions on GitHub-hosted compute through the Copilot SDK.

v1 deliberately includes only Discord, GitHub Copilot cloud sessions, durable
PostgreSQL state, and a human approval gate. It does not include Railway
Sandboxes, local repository execution, BYOK, multi-user accounts, Telegram,
WhatsApp, guild channels, local stdio MCP, Redis, a workflow engine, automatic
pushes, pull requests, merges, or scheduler loops.

## Topology

```text
                         public HTTPS
Owner browser --------------------------------> web/API :3000
                                                   |
                                                   | PostgreSQL state, jobs, events
                                                   v
Owner Discord DM <--------------------------> gateway :3001
                                                   |
                                                   v
                                              PostgreSQL
                                                   ^
                                                   | claims jobs; stores results
                                                   |
                                             harness :3002
                                                   |
                                      Copilot SDK + fine-grained PAT
                                                   v
                         GitHub Copilot Mission Control / cloud sandbox
```

Railway hosts only `web`, `gateway`, `harness`, and PostgreSQL. It does not
host the coding workspace or sandbox. GitHub-hosted Copilot cloud sessions do.

## Services and trust boundaries

| Component | Public/connected surface | Responsibility | Sensitive inputs |
| --- | --- | --- | --- |
| `apps/web` | Public web domain; browser API and SSE | First-run owner setup, login, session/job creation, transcript/event reads, settings, approvals, audit | `DATABASE_URL`, `OPENTENTACLES_ENCRYPTION_KEY`, `OPENTENTACLES_SESSION_KEY`, app URL |
| `apps/gateway` | Outbound Discord Gateway and REST API | Owner-only DMs, commands, typing, durable outgoing Discord delivery | `DATABASE_URL`, encryption key; decrypts Discord token from PostgreSQL |
| `apps/harness` | Copilot SDK and GitHub cloud sessions | Claims jobs, creates/resumes/stops sessions, streams and persists events, evaluates permission requests | `DATABASE_URL`, encryption key, `COPILOT_GITHUB_TOKEN` |
| `packages/core` | Internal shared code only | Database connection, migrations, crypto, queue claims, persistence, policy | No process of its own |
| PostgreSQL | Private service network | Durable source of truth for state, queues, events, approvals, deliveries, settings, encrypted secrets, and audit | Railway-managed database credentials |

Only `web` should receive a public domain. The gateway and harness expose
`/health` for platform checks but should remain private.

The fine-grained Copilot PAT is scoped to `harness` only. The gateway and web
never need it: they enqueue and inspect durable records rather than call the
Copilot SDK. This limits the blast radius of a web or Discord-facing failure.
The dashboard-managed Discord token and MCP headers are encrypted at rest;
services that must use them decrypt them with the shared encryption key.

## Main flows

### Dashboard chat

1. An authenticated owner creates a session through `POST /api/sessions`.
2. The web service writes a conversation, app session, and `create` job in one
   PostgreSQL transaction.
3. The harness claims the job, provisions the remote Copilot session, and
   persists lifecycle events and the Mission Control URL.
4. A prompt sent to `POST /api/sessions/:id/prompt` is saved as a message and
   queued as a durable `prompt` job.
5. The harness sends the turn, persists buffered stream deltas and lifecycle
   events, then saves the final assistant message.
6. The browser fetches the ordered transcript and reconnects to
   `GET /api/sessions/:id/events` using `Last-Event-ID` or `after`; persisted
   event IDs make the reconnect cursor durable.

### Discord DM

1. The gateway reads encrypted Discord configuration from PostgreSQL and
   connects a Discord client.
2. It rejects bot messages, guild messages, and users other than the stored
   Discord owner before queueing work.
3. `/new owner/repo [branch] [model]`, `/sessions`, `/resume`, `/status`, and
   `/stop` map to the same conversations, sessions, and jobs as the web API.
   `/approve <id>` and `/deny <id>` resolve stored approvals.
4. Ordinary DM text is stored with Discord's message ID as an idempotency key
   before a prompt job is created.
5. Assistant output for a Discord conversation creates a durable delivery.
   The gateway claims deliveries, splits content to Discord's 2,000-character
   limit, and sends it. Failed sends are retried up to three attempts.

The current implementation starts Discord typing when a DM arrives. It sends
final assistant output through the delivery queue; it does not stream each
assistant delta directly to Discord.

### Approval

1. The harness classifies a Copilot permission request.
2. An allowed request proceeds immediately. An external request, MCP request,
   GitHub write/commit/push/PR/API command, or URL request creates a redacted,
   durable approval with a five-minute timeout.
3. The owner resolves it through the web approvals API or Discord
   `/approve`/`/deny`.
4. The harness polls the durable approval status and returns approve-once or a
   rejection. It expires an unanswered request.

## Cloud-session lifecycle

The harness starts one long-lived `CopilotClient` with
`gitHubToken: COPILOT_GITHUB_TOKEN` and `useLoggedInUser: false`.

### Create

The worker creates a session with the selected stored model, `streaming: true`,
repository owner/name/optional branch, remote HTTP/SSE MCP servers, and the
permission handler. It subscribes during `createSession`.

The first prompt must not be sent until `session.start` reports producer
`copilot-agent`. The worker waits up to 60 seconds for that event. This
prevents the cloud-session dropped-first-prompt race. A remote `session.info`
event supplies the Mission Control URL, which is stored with the app session.

### Prompt, resume, stop, and error states

- A prompt uses `session.sendAndWait` with a 30-minute timeout and changes the
  app session from `working` back to `ready` when the turn completes.
- Resume calls `client.resumeSession` using the persisted Copilot session ID,
  with `continuePendingWork: false`.
- Stop calls `session.abort()` and then `session.disconnect()`, leaving the
  persisted remote identity available for a later resume.
- A Copilot creation error with reason `policy_blocked` is persisted as the
  `policy_blocked` session status rather than retried as infrastructure work.
- On harness startup, an in-progress claimed `prompt` job is marked failed
  with a restart error. Coding turns are never automatically retried.

The standalone `apps/harness/src/spike.ts` is a manual cloud integration
probe. It exercises create, readiness waiting, streaming, Mission Control URL
capture, SDK session listing, abort, disconnect, and resume. Production code
does not currently expose model discovery or SDK session listing as a web or
Discord feature; callers provide an optional model when creating a session.

## PostgreSQL durability and recovery

`packages/core/src/migrations.ts` defines the schema. Important records are:

| Records | Purpose |
| --- | --- |
| `admins`, `web_sessions` | Single administrator and opaque web sessions |
| `settings`, `secrets`, `mcp_servers`, `tool_policy` | Configuration and encrypted dashboard-managed credentials |
| `conversations`, `messages`, `agent_sessions` | Ordered conversation history and cloud session identity |
| `jobs`, `session_events` | Durable harness work and browser-replayable lifecycle/stream events |
| `approvals`, `deliveries` | Human permission gate and outgoing Discord sends |
| `audit_log` | Authentication, session, settings, MCP, and Discord actions |

The queue uses `FOR UPDATE SKIP LOCKED`, a two-minute claim lease, a worker
identifier, and per-session exclusion of another active claim. Session
creation and prompt enqueueing use transactions; ordered messages use a
conversation sequence under row lock. Discord inbound IDs are unique, avoiding
duplicate prompt jobs. Delivery claims use the same PostgreSQL pattern.

Recovery is intentionally minimal: expired non-prompt leases can be claimed
again, but a claimed coding prompt is failed on harness restart. There is no
separate reaper, notification wake-up, or automatic reconciliation of remote
sessions; the worker polls every 500 ms and resume is an explicit control job.

## Authentication and secrets

The first owner creates a username and password only while `admins` is empty.
Passwords are hashed with Node `crypto.scrypt` using a random salt. Login
creates a random opaque token; PostgreSQL stores only its HMAC-SHA-256 hash.
The cookie is `HttpOnly`, `SameSite=Strict`, seven days long, and adds
`Secure` when `OPENTENTACLES_APP_URL` uses HTTPS. Mutating web requests check
the configured origin. Login attempts are limited in memory to ten per source
IP in fifteen minutes.

Dashboard-managed values use AES-256-GCM with a base64 32-byte
`OPENTENTACLES_ENCRYPTION_KEY`. The database holds ciphertext, nonce, and
authentication tag, not plaintext. The web settings endpoint stores the
Discord token this way; MCP request headers also use encrypted secret records.

Required environment variables:

| Variable | Scope | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | All services and migration command | PostgreSQL connection |
| `OPENTENTACLES_APP_URL` | Web; supplied to all services in the documented Railway topology | Origin and cookie security decision |
| `OPENTENTACLES_ENCRYPTION_KEY` | Web, gateway, harness | Base64 32-byte AES-GCM key |
| `OPENTENTACLES_SESSION_KEY` | Web only in current code | Base64 32-byte HMAC key for opaque cookies |
| `OPENTENTACLES_SERVICE` | Each application service | `web`, `gateway`, or `harness` process selection |
| `COPILOT_GITHUB_TOKEN` | Harness only | Fine-grained GitHub token for Copilot and selected repositories |

## Tool and MCP policy

`packages/core/src/policy.ts` is the current policy implementation:

- `read` and `write` requests are allowed.
- Shell commands are allowed unless they match GitHub writes, `curl`, `wget`,
  or selected `gh` PR/API/issue operations.
- URL and MCP requests, detected GitHub writes, and external commands require
  a persisted approval.
- Unknown requests are denied.

This implements sandbox-local read/write/test as the default allowed path
while retaining a human gate for GitHub and external effects. It is a
pattern-based policy, not a complete semantic command parser.

MCP configuration accepts only remote `http` and `sse` transports. There is no
stdio command field in the database model or web endpoint. The harness
decrypts stored headers only when configuring the SDK session.

## Deployment

The Dockerfile builds with Bun and runs the bundled services on Node 24 Alpine
as a non-root user. `scripts/start.mjs` dispatches the built service with
`OPENTENTACLES_SERVICE`; `scripts/start.ts` is the Bun development dispatcher.
The repository's `railway.json` selects the Dockerfile builder and an
on-failure restart policy.

Deploy one Railway project with:

1. One Railway PostgreSQL service.
2. Three services built from this repository, configured as `web`, `gateway`,
   and `harness`.
3. A public domain for `web` only.
4. Shared `DATABASE_URL` and encryption key where required; a web-only session
   key; and the Copilot PAT only on `harness`.

Each service invokes the idempotent migration function at startup under a
PostgreSQL advisory transaction lock. `web`, `gateway`, and `harness` serve
`/health` on ports 3000, 3001, and 3002 by default, or the Railway `PORT`.

External prerequisites remain operational requirements, not verified
integration results:

- A reachable PostgreSQL database is required to run migrations or any service.
- The harness needs a valid `COPILOT_GITHUB_TOKEN`, Copilot cloud entitlement,
  repository access, and organization policy that permits cloud sessions.
- A configured Discord application and dashboard-supplied owner ID/token are
  required before the gateway can connect.
- Docker must be running to build or exercise the container locally.

## Operations and verification

Use `/health` for simple process health. The web API exposes failed jobs,
pending approvals, settings, MCP registrations, and the latest 100 audit rows.
The gateway emits structured JSON status/errors to stdout and refreshes its
Discord configuration every 15 seconds. The harness redacts token-like values
and sensitive property names before persisting SDK event payloads or errors.

The current automated coverage is limited to crypto round trips/password
verification and policy classification in `test/new/core/crypto.test.ts`.
Typecheck, lint, and Node-target bundling are local checks. Live cloud,
PostgreSQL migration, and container checks require `COPILOT_GITHUB_TOKEN`,
`DATABASE_URL`, and Docker respectively; they must be run in an appropriately
provisioned environment.

## Developer map

```text
apps/
  web/src/index.ts          Web HTML/API/SSE/auth/settings server
  gateway/src/index.ts      Discord DM ingestion and delivery worker
  harness/src/index.ts      Harness process and health endpoint
  harness/src/worker.ts     Copilot cloud lifecycle, policy, durable worker
  harness/src/spike.ts      Manual live cloud SDK probe
packages/core/src/
  crypto.ts                 Passwords, opaque session hashes, AES-GCM
  db.ts                     PostgreSQL connection
  migrations.ts             Schema and startup migration
  migrate.ts                Migration command entry point
  policy.ts                 Permission classifier
  queue.ts                  Durable job claim and completion
  store.ts                  Transactions and persistence helpers
scripts/
  start.ts                  Bun development service dispatcher
  start.mjs                 Node production service dispatcher
test/new/core/crypto.test.ts Focused crypto and policy tests
```

Source-of-truth project documents and configuration are:

- `README.md` for setup and Railway topology.
- `docs/ARCHITECTURE.md` for the implemented system described here.
- `docs/VISION.md` for the product boundary.
- `AGENTS.md` and `.github/copilot-instructions.md` for agent constraints.
- `.env.example` for required variables.
- `Dockerfile`, `railway.json`, `package.json`, and `scripts/start.*` for
  runtime/build dispatch.
