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

# Create non-root user for security (Trivy DS002)
RUN addgroup --gid 1001 opententacles && \
    adduser --uid 1001 --ingroup opententacles --disabled-password --no-create-home opententacles

# Copy built output and runtime manifest
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/bun.lock ./bun.lock

# Install production deps only
RUN bun install --production --frozen-lockfile

# Pre-create the data directory and grant ownership to the non-root user
# so Railway volume mounts at /data are writable
RUN mkdir -p /data && chown opententacles:opententacles /data

USER opententacles

ENV NODE_ENV=production

CMD ["bun", "run", "dist/cli.js", "start"]
