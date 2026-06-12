# Nango in HIVEMIND — OAuth Control Plane

> Self-hosted Nango (`nangohq/nango-server:hosted`, v0.70.x) is HIVEMIND's
> OAuth vault: it runs provider OAuth flows, stores tokens encrypted, and
> auto-refreshes them. Two containers, one Postgres database, one rule:
> **core never stores third-party OAuth tokens itself for Nango-backed
> providers — it asks Nango for a fresh bearer at call time.**
>
> Verified against prod 2026-06-12. Slack is the exception — it moved to a
> native OAuth flow (see `docs/SLACK.md`).

---

## 1. Topology

| Piece | Container | Public | Role |
|---|---|---|---|
| Nango server | `hivemind-nango` | `https://api.hivemind.davinciai.eu:8042` (via `hivemind-caddy-nango`) | REST API, token vault, OAuth code exchange, auto-refresh |
| Connect UI | `hivemind-nango-connect-ui` | `https://api.hivemind.davinciai.eu:8043` (via `hivemind-caddy-connect-ui`) | The popup users see when connecting. Stateless — holds no tokens |
| Database | `nango` DB inside `postgres-s0k0…` | — | `_nango_configs` (integrations), `_nango_connections` (tokens, encrypted), `_nango_environments` |

Internal address from any HIVEMIND container: `http://hivemind-nango:8080`.
Secret key: env `NANGO_SECRET_KEY` on `hm-core` (NOT the value in old docs —
always read it from the container env).

## 2. The two sources of truth (and how they sync)

1. **Nango's `_nango_connections`** — the actual tokens.
2. **HIVEMIND's `hivemind.nango_connections`** — ownership mapping:
   `(user_id, org_id, provider_key) → connection_id, status`. Core resolves
   "which connection does this user have for gmail" from HERE, then fetches
   the bearer from Nango.

Sync paths:
- **Connect finalize**: the FE popup's `connect` event → core
  `POST /api/connectors/connect` upserts the hivemind row.
- **Webhook** (configured 2026-06-12): Nango → `http://hm-core:3000/api/connectors/nango/webhook`
  (`_nango_environments.webhook_url`, all envs). Core's handler
  (`webhooks/nango-webhook-handler.js`) is whitelisted in
  `PUBLIC_WEBHOOK_PATHS` (auth via signature, not API key).

## 3. Registered integrations (prod, 2026-06-12)

| unique_key | provider | creds |
|---|---|---|
| `gmail` | google-mail | ✓ |
| `google-docs` | google-docs | ✓ |
| `google-drive` | google-drive | ✓ (added 2026-06-12 via API) |
| `google-calendar` | google-calendar | ✓ (added 2026-06-12 via API) |
| `google-gemini` | google-gemini | API-key style (no OAuth creds) |
| `notion`, `notion-mcp` | notion-mcp | — |
| `salesforce`, `salesforce-jwt` | salesforce | ✓ |
| `slack` | slack-mcp | **legacy — Slack is native OAuth now** |

All Google integrations share ONE Google OAuth client
(`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` env on hm-core), whose callback
`https://api.hivemind.davinciai.eu:8042/oauth/callback` is whitelisted in
Google Cloud Console — adding another Google product needs **no console
work**, just an API call:

```bash
NSEC=$(docker exec hm-core printenv NANGO_SECRET_KEY)
curl -X POST http://hivemind-nango:8080/integrations \
  -H "Authorization: Bearer $NSEC" -H 'content-type: application/json' \
  -d '{"unique_key":"google-sheets","provider":"google-sheet",
       "credentials":{"type":"OAUTH2","client_id":"<GCID>","client_secret":"<GCSEC>",
                      "scopes":"https://www.googleapis.com/auth/spreadsheets.readonly"}}'
```

(Endpoint is `POST /integrations` with a `credentials` object — the older
`POST /config` shape 404s on this version.)

## 4. The user connect flow, end to end

```
FE Connectors page "Connect"
  → core POST /api/connectors/connect-session  body: { connector_id: "gmail" }
      (resolves catalog entry → nango_provider, calls Nango POST /connect/sessions)
  ← { connect_session_token: "nango_connect_session_…" }
  → FE opens Connect UI popup (:8043) with the token  (openConnectUI + self-hosted baseURL)
  → user authorizes at Google/Notion/…
  → Nango exchanges the code, stores + will auto-refresh the token
  → popup fires 'connect' → FE → core /api/connectors/connect → hivemind row upserted
  → (also) Nango webhook → core /api/connectors/nango/webhook
```

`connector_id` accepts the catalog name (`gmail-ingestion`), the FE id
(`gmail`), or the nango provider key — the endpoint list-and-finds all three.

## 5. How tokens are consumed

| Caller | Path |
|---|---|
| Chat agent REST tools (gmail/gdocs/gemini) | `connector-toolkits/nango-fetch.js` → `getConnectionId` → `fetchBearerFromNango` |
| MCP live tools (notion/github/linear) | `agent/mcp-client-pool.js` bearerResolver |
| MCP ingestion endpoints + Connectors status | `connectors/mcp/service.js` → `enrichEndpointWithToken` |
| Sync engine / connector store | `connector-store.getAccessToken` — **Nango-first, falls back to the legacy `platform_integrations` row** |

`GET /connection/<id>?provider_config_key=<key>` is the bearer fetch — note
the query-param shape; the path-style `/connection/<key>/<id>` 404s.

## 6. Failure modes & the guards now in place (hard-won)

1. **Dead connection, infinite retry (HTTP 424 "refresh limit has been
   reached")** — a connection whose refresh token is burned never recovers.
   Both consumer paths now SELF-HEAL: on `refresh limit|invalid_credentials|424`
   they flip the hivemind row to `status='error'` so lookups stop returning it
   and the FE shows **Reconnect**. (`connector-store.js` + `nango-service.js
   enrichEndpointWithToken`, commits `49991f1`, `538fcbe`.)
2. **`Argument orgId must not be null`** — `nango_connections.org_id` is
   non-nullable; passing `orgId: null` into a Prisma where throws.
   `getConnectionId` now omits the field when falsy. This crashed every
   scheduled Slack sync for weeks.
3. **Connected-but-FE-says-Connect** — `/v1/connectors` only promoted overlay
   rows whose provider existed in `PROVIDER_REGISTRY`; google-docs etc.
   vanished (`overlay rows=1, promoted=0`). Fixed: unmatched overlay rows are
   appended as synthetic `connected` entries (commit `742cd76`). **Verified
   live**: `overlay promoted=1 providers=google-docs`.
4. **Provider key vs template name** — code must use the integration
   `unique_key` (what's in `_nango_configs.unique_key`), never the Nango
   template name (`google-mail` is the template; `gmail` is our key).
5. **Connect-button 403 for non-admins** — the FE scope selector preloads
   `target_scope` from EXISTING connector rows; if an admin connected a
   provider org-wide, every viewer inherited `'organization'` and
   `/v1/connectors/:provider/start` 403'd them (`assertPermission` →
   `connector:manage` is `org_owner`/`org_admin` only, thrown as a bare
   "Forbidden"). The FE now retries any `/start` 403 with
   `target_scope:'personal'` + a toast (commits `9f3c90c`, `088c11e`). The
   backend gate itself is correct and unchanged.
6. **Brand logos** — connector cards use simple-icons CDN; OpenAI/Slack/
   Salesforce were trademark-purged there (404) and come from iconify's
   `logos` collection instead (`5daa04e`). Every URL in `BRAND_LOGOS`
   (Connectors.jsx) must stay curl-verified 200.

## 7. Ops runbook

```bash
# Integration inventory
docker exec <pg> psql -U hivemind_user -d nango -c \
  "SELECT unique_key, provider FROM nango._nango_configs;"

# A user's connections (HIVEMIND side)
docker exec <pg> psql -U hivemind_user -d hivemind -c \
  "SELECT provider_key, connection_id, status FROM hivemind.nango_connections WHERE user_id='<uuid>';"

# Mint a connect session by hand (proves the whole flow is up)
curl -X POST http://localhost:3000/api/connectors/connect-session \
  -H "X-API-Key: $MASTER" -H "X-HM-User-Id: <u>" -H "X-HM-Org-Id: <o>" \
  -d '{"connector_id":"gmail"}'        # → { connect_session_token: … }

# Health
curl -k https://api.hivemind.davinciai.eu:8042/health   # server
curl -k https://api.hivemind.davinciai.eu:8043/         # connect UI
```

Dead-connection cleanup (manual, when self-heal hasn't seen the row yet):
`UPDATE hivemind.nango_connections SET status='error' WHERE connection_id='…';`
The user then reconnects from the Connectors page — re-auth creates a fresh
connection id.
