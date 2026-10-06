FROM oven/bun:1-alpine AS builder
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN bun run build

FROM node:24-alpine AS production
WORKDIR /app
RUN addgroup --gid 1001 opententacles && adduser --uid 1001 --ingroup opententacles --disabled-password --no-create-home opententacles
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY scripts/start.mjs ./scripts/start.mjs
USER opententacles
ENV NODE_ENV=production
CMD ["node", "scripts/start.mjs"]
