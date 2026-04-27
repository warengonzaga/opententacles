# ── Stage 1: Install deps ───────────────────────────────────────────
FROM oven/bun:1-alpine AS deps

WORKDIR /app

# Copy manifests first for layer caching
COPY package.json bun.lock ./

# Production-only install. Bun runs TypeScript natively at runtime, so
# no build/transpile step is required.
RUN bun install --frozen-lockfile --production

# ── Stage 2: Production ─────────────────────────────────────────────
FROM oven/bun:1-alpine AS production

WORKDIR /app

# - su-exec: drop privileges from root → opententacles after fixing
#   volume ownership at runtime (Railway mounts volumes as root-owned).
# - git: required by the agent for clone/fetch/pull on repos inside the
#   workspace directory.
RUN apk add --no-cache su-exec git

# Create non-root user for security (Trivy DS002)
RUN addgroup --gid 1001 opententacles && \
    adduser --uid 1001 --ingroup opententacles --disabled-password --no-create-home opententacles

# Production node_modules
COPY --from=deps /app/node_modules ./node_modules

# Application source. Channels are loaded dynamically at runtime from
# src/channels/<name>/index.ts, so source must be present (not bundled).
COPY package.json bun.lock tsconfig.json ./
COPY src/ ./src/

# Entrypoint runs as root to fix data dir ownership (Railway mounts
# volumes as root-owned), then drops to the opententacles user via su-exec.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["bun", "run", "src/cli.ts", "start"]
