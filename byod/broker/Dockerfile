FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
# Locked, script-free install: the lockfile pins every tarball and integrity hash,
# and no dependency needs a lifecycle script (pg and its tree are pure JS).
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server.mjs ./
COPY cloudflare-tunnel.mjs ./
COPY endpoint-policy.mjs ./
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8790/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
EXPOSE 8790
CMD ["node", "server.mjs"]
