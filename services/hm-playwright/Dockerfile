# hm-playwright — server-side headless browser as an MCP server (@playwright/mcp).
# The "web automation" backend that needs NO user install: agents use it for public
# sites / research. (The other backend, Kimi WebBridge, drives the user's REAL
# logged-in browser.) Internal-only; reached by the Hermes gateway on the docker net.
FROM mcr.microsoft.com/playwright:v1.49.1-noble
WORKDIR /app
ARG PLAYWRIGHT_MCP_VERSION=0.0.78
RUN npm init -y >/dev/null 2>&1 \
    && npm i "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" "@cloudflare/realtimekit@2.0.2" \
    && npx "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" install-browser chrome-for-testing
COPY server.mjs /app/server.mjs
RUN mkdir -p /app/sessions
EXPOSE 8931 8932
# server.mjs keeps the existing isolated MCP endpoint on :8931 and adds a
# scoped, lazy-browser crawl API on :8932 for deterministic SEO capabilities.
CMD ["node","/app/server.mjs"]
