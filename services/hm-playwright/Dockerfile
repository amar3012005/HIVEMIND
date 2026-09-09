# hm-playwright — authenticated gateway over Docker's official Playwright MCP
# image.  Pin the published image digest rather than reproducing the server
# with an unrelated Playwright base and a floating npm install.
FROM mcp/playwright@sha256:8771dc4666e7c11440bfc6a0c6b00480e9a15b8891b45f29a52d7d995f8d1492
USER root
WORKDIR /app
RUN npm init -y >/dev/null 2>&1 \
    && npm i "@cloudflare/realtimekit@2.0.2" esbuild \
    && npx esbuild node_modules/@cloudflare/realtimekit/dist/index.es.js --bundle --format=esm --platform=browser --outfile=/app/realtimekit.bundle.js \
    && mkdir -p /app/sessions \
    && chown -R node:node /app
COPY --chown=node:node server.mjs /app/server.mjs
COPY --chown=node:node external-mcp-gateway.mjs /app/external-mcp-gateway.mjs
USER node
EXPOSE 8931 8932
# The stock MCP child binds only to loopback. Authenticated external MCP and
# the bounded crawl/session API are exposed through server.mjs on :8932.
ENTRYPOINT []
CMD ["node", "/app/server.mjs"]
