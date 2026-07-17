# OpenTentacles

Keep web, gateway, and harness isolated. Use PostgreSQL for durable queues, events, approvals, deliveries, audit state, and configuration. Only the harness uses the Copilot SDK and its fine-grained GitHub token.

For cloud sessions, subscribe before sending and await `session.start` from `copilot-agent`; persist remote `session.info` URLs. Auto-allow sandbox-local reads, writes, and tests. Require a durable approval for GitHub writes and external side effects.
