# hm-playwright — server-side headless browser as an MCP server (@playwright/mcp).
# The "web automation" backend that needs NO user install: agents use it for public
# sites / research. (The other backend, Kimi WebBridge, drives the user's REAL
# logged-in browser.) Internal-only; reached by the Hermes gateway on the docker net.
FROM mcr.microsoft.com/playwright:v1.49.1-noble
WORKDIR /app
ARG PLAYWRIGHT_MCP_VERSION=0.0.78
RUN npm init -y >/dev/null 2>&1 \
    && npm i "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
    && npx "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" install-browser chrome-for-testing
EXPOSE 8931
# Headless, all-interfaces, isolated context per session. /mcp endpoint.
CMD ["npx","--no-install","@playwright/mcp","--headless","--browser","chromium","--host","0.0.0.0","--port","8931","--isolated","--allowed-hosts","*"]
