# hm-agent — data-plane agent. Memory engine per AGENT_STORE: pg-qdrant (default) | amr.
# trixie base: the .amr native binding links glibc's libmvec (vectorized math), which exists on
# aarch64 only from glibc 2.38+ — bookworm (node:20-slim) lacks it and dlopen fails.
FROM node:20-trixie-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs ./
# .amr engine module + native bindings (loaded only when AGENT_STORE=amr)
COPY mneme/ ./mneme/
EXPOSE 8787
CMD ["node", "server.mjs"]
