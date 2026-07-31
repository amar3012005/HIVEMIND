# Connectors

**Group:** Your Brain · **Route:** `/hivemind/app/connectors`
**Status:** UNAUDITED — no production review yet

## Frontend
- `pages/Connectors.jsx`
- `pages/WhatsAppQRModal.jsx`

## Backend endpoints called (30)
- `/v1/api-keys`
- `/v1/clients/descriptors`
- `/v1/connectors`
- `/v1/connectors/${provider}/disconnect`
- `/v1/connectors/${provider}/resync`
- `/v1/connectors/${provider}/start`
- `/v1/connectors/whatsapp/disconnect`
- `/v1/connectors/whatsapp/qr`
- `/v1/connectors/whatsapp/status`
- `/v1/oauth/clients`
- `/v1/oauth/clients/${encodeURIComponent(clientId)}`
- `/v1/proxy/connectors/${provider}/scope`
- `/v1/proxy/connectors/cadence`
- `/v1/proxy/connectors/claude-web/disconnect`
- `/v1/proxy/connectors/claude-web/status`
- `/v1/proxy/connectors/connect`
- `/v1/proxy/connectors/connect-session`
- `/v1/proxy/connectors/gmail/connect`
- `/v1/proxy/connectors/gmail/disconnect`
- `/v1/proxy/connectors/gmail/flush`
- `/v1/proxy/connectors/gmail/ingest-selected`
- `/v1/proxy/connectors/gmail/preview`
- `/v1/proxy/connectors/gmail/sync`
- `/v1/proxy/connectors/google/status`
- `/v1/proxy/connectors/google/sync`
- `/v1/proxy/connectors/mcp/endpoints`
- `/v1/proxy/connectors/mcp/jobs`
- `/v1/proxy/connectors/mcp/status`
- `/v1/proxy/seo/search-console/properties`
- `/v1/proxy/seo/search-console/property`

## Backend implementation
_Not yet traced. Fill in: which service (core :2026 / control-plane :2027), the
handler, and the storage it touches._

## Production guardrails
_For each, record VERIFIED / MISSING with the evidence that settled it._

- [ ] **Tenant isolation** — every query scoped by `org_id`; verified with a two-org fixture
- [ ] **AuthZ** — endpoint rejects an unauthenticated and a wrong-org caller
- [ ] **Input validation** — rejects malformed input rather than degrading silently
- [ ] **Failure mode** — a dependency outage returns an explicit error, never a
      success-shaped empty result (the `/api/recall` trap: an unread query returned
      200 + zero results, indistinguishable from "no data")
- [ ] **Idempotency** — a retried call cannot double-write
- [ ] **Observability** — a failure is visible without reading source
- [ ] **Reproducibility** — one command exercises it end to end against a real tenant

## Reproduction
```bash
# scoped key required — headers cannot impersonate an org, and the master key
# resolves to DEFAULT_ORG. Mint one:
#   curl -s -X POST http://127.0.0.1:2027/v1/api-keys \
#     -H "Authorization: Bearer <sessionId>" -H 'Content-Type: application/json' \
#     -d '{"name":"audit"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["api_key"])'
```
_TODO: the actual command that proves this feature works._

## Known issues
_None recorded yet._
