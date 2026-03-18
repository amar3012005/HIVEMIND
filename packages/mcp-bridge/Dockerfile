# HIVE-MIND MCP Bridge - Production Dockerfile
# For antigravity project integration

FROM node:20-slim AS base

RUN apt-get update && \
    apt-get install -y --no-install-recommends dumb-init ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ==========================================
# BUILD STAGE
# ==========================================
FROM base AS builder

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci && npm cache clean --force

# Copy source code
COPY src ./src
COPY tsconfig.json ./

# Build TypeScript
RUN npm run build

# ==========================================
# PRODUCTION STAGE
# ==========================================
FROM base AS production

ARG NODE_ENV=production
ARG VERSION=2.0.0

ENV NODE_ENV=${NODE_ENV} \
    VERSION=${VERSION} \
    PORT=3001 \
    HOST=0.0.0.0

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

RUN mkdir -p /app/logs && chown -R nodejs:nodejs /app

USER nodejs

# Copy from builder
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./

RUN chmod -R 550 /app && chmod -R 770 /app/logs

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/cli.js"]
