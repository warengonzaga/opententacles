# ── Stage 1: Install deps ───────────────────────────────────────────
FROM oven/bun:1-debian AS deps

WORKDIR /app

# Copy manifests first for layer caching
COPY package.json bun.lock ./

# Production-only install. Bun runs TypeScript natively at runtime, so
# no build/transpile step is required.
RUN bun install --frozen-lockfile --production

# ── Stage 2: Production ─────────────────────────────────────────────
FROM oven/bun:1-debian AS production

WORKDIR /app

# Bun runs the app, but the @github/copilot CLI (spawned as a subprocess
# by @github/copilot-sdk) requires Node.js v24+ — it uses node:sea which
# Bun does not implement. We also need glibc (hence debian, not alpine)
# because @github/copilot-linux-x64 ships glibc-only prebuilt binaries.
#
# - nodejs (v24+): runtime for the spawned Copilot CLI subprocess
# - git: required by the agent for clone/fetch/pull on cloned repos
# - gosu: drop privileges from root → opententacles after fixing volume
#   ownership at runtime (Railway mounts volumes as root-owned)
# - ca-certificates, curl: needed for the NodeSource setup script
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg git gosu && \
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get purge -y --auto-remove curl gnupg && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user for security (Trivy DS002)
RUN groupadd --gid 1001 opententacles && \
    useradd --uid 1001 --gid 1001 --no-create-home --shell /usr/sbin/nologin opententacles

# Production node_modules
COPY --from=deps /app/node_modules ./node_modules

# Application source. Channels are loaded dynamically at runtime from
# src/channels/<name>/index.ts, so source must be present (not bundled).
COPY package.json bun.lock tsconfig.json ./
COPY src/ ./src/

# Entrypoint runs as root to fix data dir ownership (Railway mounts
# volumes as root-owned), then drops to the opententacles user via gosu.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["bun", "run", "src/cli.ts", "start"]
