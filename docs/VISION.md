# Vision

OpenTentacles gives one deployment owner a durable, human-gated way to control GitHub-hosted Copilot cloud sessions from a dashboard and Discord DMs.

The product boundary is deliberately narrow: PostgreSQL holds durable state; the web service authenticates and reviews; the gateway only transports owner DMs; the harness is the only Copilot control plane. GitHub cloud sandboxes provide execution isolation. A human approves external side effects.

We will not add a channel framework, local worker, BYOK router, multi-tenancy, automatic pull requests, merges, scheduled loops, Redis, or a workflow engine until the single-session path is proven and measured.
