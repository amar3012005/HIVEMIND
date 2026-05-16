# Coolify deploy entrypoint for repositories configured with deploy/docker-compose.yml.
# Build context is the repository root, so paths below are rooted at /opt/HIVEMIND.

FROM node:20-slim AS base

RUN apt-get update && \
    apt-get install -y --no-install-recommends dumb-init ca-certificates openssl tzdata wget && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS builder

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ git && \
    rm -rf /var/lib/apt/lists/*

COPY core/package.json core/package-lock.json ./
COPY core/prisma ./prisma
COPY core/tsconfig.json ./

RUN npm ci || npm install --no-audit --no-fund && npm cache clean --force

ARG CACHE_BUST=1

COPY core/src ./src
COPY core/config ./config

RUN npx prisma generate

FROM base AS production

ARG NODE_ENV=production
ARG VERSION=1.0.0
ARG BUILD_DATE=unknown

ENV NODE_ENV=${NODE_ENV} \
    VERSION=${VERSION} \
    BUILD_DATE=${BUILD_DATE} \
    PORT=3000 \
    HOST=0.0.0.0 \
    LOG_LEVEL=info \
    LOG_FORMAT=json

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --ingroup nodejs nodejs

RUN mkdir -p /app/logs /app/data && \
    chown -R nodejs:nodejs /app

USER nodejs

COPY --from=builder --chown=nodejs:nodejs /app/src ./src
COPY --from=builder --chown=nodejs:nodejs /app/config ./config
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nodejs:nodejs /app/prisma ./prisma

RUN chmod -R 550 /app && chmod -R 770 /app/logs /app/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:${PORT}/health || exit 1

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["sh", "-c", "npx prisma migrate deploy --schema=prisma/schema.prisma 2>&1 || echo 'Migration skipped'; node src/server.js"]