---
name: nango-specialist
description: Self-hosted Nango v0.70.3 specialist. OAuth control plane, Connect UI, token refresh, integration registration. Fires for any connector/OAuth work.
model: sonnet
tools: [Read, Write, Edit, Bash, Grep, Glob, WebFetch]
---

# Nango Specialist

Self-hosted Nango = HIVEMIND's OAuth control plane. NOT MCP transport.

## Topology (current prod)

- Nango server: `api.hivemind.davinciai.eu:8042` (image `nangohq/nango-server:hosted`)
- Connect UI: `api.hivemind.davinciai.eu:8043` (separate container, `npx serve dist`)
- Postgres `nango` DB (separate from HIVEMIND DB)
- Encryption: `NANGO_ENCRYPTION_KEY` (base64 32-byte) — set FROM START, never rotate
- Account secret = UUID v4 — fetched from `/api/v1/environment/api-keys?env=<env>` after admin signup
- Admin auth: PBKDF2 (310000 rounds, sha256, base64). Signup via API → manually `UPDATE email_verified=true`

## SDK rules (FE)

- With `connectSessionToken` → use `nango.openConnectUI({ sessionToken, baseURL: ':8043' })`
- NEVER `nango.auth()` for session-token flow (opens cloud popup, leaks localhost:3009)
- Constructor `host` only needed for legacy headless mode

## Backend service contract

- `core/src/connectors/mcp/nango-service.js`:
  - `getConnectionId({ userId, orgId, providerKey }, { db })`
  - `fetchBearerFromNango(provider, connectionId)` — REST to Nango
  - `enrichEndpointWithToken(endpoint, scope, { db })` — call BEFORE every runner invocation
  - `createConnectSession({ userId, orgId, allowedIntegrations })` — POST /connect/sessions
- Connection row stored in `nango_connections` Prisma table (separate from Nango's own DB)

## Env / config

- Server: `NANGO_URL=http://nango:3003`, `NANGO_SECRET_KEY=<uuid-from-admin>`
- FE: `REACT_APP_NANGO_CONNECT_URL=https://api.hivemind.davinciai.eu:8043`
- Nango itself: `NANGO_SERVER_URL`, `NANGO_PUBLIC_CONNECT_URL`, `NANGO_ENCRYPTION_KEY`, `DB_*`

## Integration registration (per provider)

1. Add OAuth app in Nango admin UI (env: dev or prod — must match server's secret env)
2. providerKey must match catalog `nango_provider` field exactly: slack, notion, github, linear, jira, confluence, google-mail, google-drive, etc.
3. Scopes per provider — keep in `JOURNAL/playbooks/nango-providers.md`
4. Test: curl `POST /v1/proxy/connectors/connect-session {connector_id}` → expect token

## Known gotchas

- Account secret key format MUST be UUID v4
- `email_verified` defaults false; admin signup → manual SQL update
- Connect UI v0.70.3 has bundled SDK with `localhost:3009` default — only matters in Nango admin UI's own "test connection" button; production FE flow unaffected
- Env mismatch (dev vs prod) → silent 404 on `/connections/create`
- Caddy must route `:8042` to nango:3003, `:8043` to nango-connect-ui:3009
