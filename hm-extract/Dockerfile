# hm-extract — stateless bytes-in/segments-out document extraction.
# See .claude/decision-docs/HM_EXTRACT_PLAN.md (main hivemind repo).
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

COPY src/ ./src/

# UV_THREADPOOL_SIZE is the REAL concurrency lever for anydoc's Node binding
# (libuv thread pool, defaults to 4 regardless of CPU count — see
# HM_EXTRACT_PLAN.md §1). Set to the container's actual CPU allocation at
# deploy time via docker-compose/orchestrator env, not hardcoded here.
ENV NODE_ENV=production
ENV PORT=8088

EXPOSE 8088

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:8088/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Never run as root — this service accepts untrusted file uploads.
RUN useradd --system --uid 10001 hmextract
USER hmextract

CMD ["node", "src/server.js"]
