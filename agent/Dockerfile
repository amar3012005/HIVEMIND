# hm-agent — data-plane agent (Phase 1: Postgres + Qdrant). Tiny: node + pg client.
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
# Locked, script-free install: the lockfile pins every tarball and integrity hash,
# and no dependency needs a lifecycle script (pg and its tree are pure JS).
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server.mjs ./
EXPOSE 8787
CMD ["node", "server.mjs"]
