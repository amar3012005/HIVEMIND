# hm-playwright — server-side headless browser as an MCP server (@playwright/mcp).
# The "web automation" backend that needs NO user install: agents use it for public
# sites / research. (The other backend, Kimi WebBridge, drives the user's REAL
# logged-in browser.) Internal-only; reached by the Hermes gateway on the docker net.
FROM mcr.microsoft.com/playwright:v1.49.1-noble
WORKDIR /app
ARG PLAYWRIGHT_MCP_VERSION=0.0.78
RUN npm init -y >/dev/null 2>&1 \
    && npm i "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" "@cloudflare/realtimekit@2.0.2" esbuild \
    && npx esbuild node_modules/@cloudflare/realtimekit/dist/index.es.js --bundle --format=esm --platform=browser --outfile=/app/realtimekit.bundle.js \
    && npx "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" install-browser chrome-for-testing
COPY server.mjs /app/server.mjs
COPY external-mcp-gateway.mjs /app/external-mcp-gateway.mjs
COPY playwright-meta-toolkit.mjs /app/playwright-meta-toolkit.mjs
RUN mkdir -p /app/sessions
EXPOSE 8931 8932
# The stock MCP child binds only to loopback. Authenticated external MCP and
# the bounded crawl/session API are exposed through server.mjs on :8932.
CMD ["node","/app/server.mjs"]
