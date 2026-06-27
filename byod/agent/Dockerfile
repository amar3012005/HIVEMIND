# hm-agent — data-plane agent (Phase 1: Postgres + Qdrant). Tiny: node + pg client.
FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs ./
EXPOSE 8787
CMD ["node", "server.mjs"]
