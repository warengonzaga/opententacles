# ── Stage 1: Install + Build ────────────────────────────────────────
FROM oven/bun:1-alpine AS builder

WORKDIR /app

# Copy manifests first for layer caching
COPY package.json bun.lock tsconfig.json ./

# Install all deps (dev included — needed to build)
RUN bun install --frozen-lockfile

# Copy source
COPY src/ ./src/

# Build
RUN bun run build

# ── Stage 2: Production ─────────────────────────────────────────────
FROM oven/bun:1-alpine AS production

WORKDIR /app

# Install su-exec so the entrypoint can drop privileges from root → opententacles
# after fixing volume ownership at runtime (needed for Railway volume mounts)
RUN apk add --no-cache su-exec

# Create non-root user for security (Trivy DS002)
RUN addgroup --gid 1001 opententacles && \
    adduser --uid 1001 --ingroup opententacles --disabled-password --no-create-home opententacles

# Copy built output and runtime manifest
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/bun.lock ./bun.lock

# Install production deps only
RUN bun install --production --frozen-lockfile

# Entrypoint script runs as root to fix data dir ownership (Railway mounts
# volumes as root-owned), then drops to the opententacles user via su-exec.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["bun", "run", "dist/cli.js", "start"]
