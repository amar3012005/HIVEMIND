# External Playwright MCP

Production Playwright remains an internal service. Optional external MCP access
uses this complete boundary:

```text
AI client -> optional Cloudflare Access -> dedicated Tunnel
          -> 127.0.0.1:8932/mcp -> origin Bearer authentication
          -> loopback-only @playwright/mcp child on 127.0.0.1:8931
```

The raw MCP child must never bind a host port or a public interface. The
gateway is fail-closed unless `PLAYWRIGHT_EXTERNAL_MCP_ENABLED=true`, limits
request size and concurrent connections, strips Access and origin credentials
before forwarding, and emits content-free start/completion/failure events.

## Client contract

Each external agent receives the independently rotated external Playwright MCP
token. Cloudflare Access service-token headers are added only when Access is enabled:

```json
{
  "mcpServers": {
    "hivemind-playwright": {
      "url": "https://playwright-mcp.singulancelabs.com/mcp",
      "headers": {
        "Authorization": "Bearer ${PLAYWRIGHT_EXTERNAL_MCP_TOKEN}"
      }
    }
  }
}
```

When Access is enabled, add `CF-Access-Client-Id` and
`CF-Access-Client-Secret` to the same headers object.

For token-efficient agents, prefer the progressive meta-tool endpoint:

```text
https://playwright-mcp.singulancelabs.com/meta/mcp
```

It advertises only `browser_capabilities` and `browser_execute`. The first
returns a bounded relevant subset of the 24 underlying tools; the second
executes exactly one returned capability. Its default `read` policy blocks
form input, clicks, uploads, dialog handling, and every unsafe JavaScript/code
surface. Set `PLAYWRIGHT_EXTERNAL_MCP_META_MODE=interactive` only for a
separately approved client boundary. `browser_evaluate` and
`browser_run_code_unsafe` remain forbidden in every meta mode.

Never place these values in Git, shared chat, command history, screenshots, or
logs. Store them in the consuming agent's secret manager. Revoke one Access
service token without rotating every client; rotate the origin token when the
service boundary itself may have been compromised.

## Cloudflare contract

- Dedicated remotely managed Tunnel and DNS hostname.
- Self-hosted Access application for the exact hostname.
- `service_auth` policy limited to explicitly issued service tokens.
- Unauthorized requests return `401`, not an identity redirect.
- Tunnel ingress validates the Access JWT and targets
  `http://127.0.0.1:8932`; the final ingress rule returns `404`.
- No direct DNS record points to the Singulance server IP.

An acceptance run must prove: unauthenticated `401`, Access-only `401` at the
origin gateway, complete authenticated MCP initialize/list-tools, one bounded
browser navigation, sibling `/health`, and no fresh fatal service logs.

The production connector unit is tracked at
`infra/systemd/hivemind-playwright-mcp-tunnel.service` and installed with
`scripts/install-playwright-mcp-tunnel-service.sh`. Its Cloudflare connector
token is never stored in Git.
