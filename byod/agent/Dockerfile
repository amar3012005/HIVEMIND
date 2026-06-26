# hm-agent — customer-box data plane. Tiny: node + the vendored mneme engine + linux binding.
FROM node:20-slim
WORKDIR /app
COPY package.json ./
# pg is optional (only needed for /v1/hydrate against a local Postgres)
RUN npm install --omit=dev --no-audit --no-fund 2>/dev/null || true
COPY server.mjs ./
COPY mneme ./mneme
ENV MNEME_BINDING=/app/mneme/singulance-amr.linux-x64-gnu.node
EXPOSE 8787
CMD ["node", "server.mjs"]
