# Workspace Admin

**Group:** Workspace Admin · **Route:** `/hivemind/app/workspace`
**Status:** UNAUDITED — no production review yet

## Frontend
- `pages/WorkspaceAdmin.jsx`
- `pages/AdminUsers.jsx`
- `pages/AdminSso.jsx`

## Backend endpoints called (9)
- `/v1/orgs/${orgId}/invites${qs`
- `/v1/orgs/${orgId}/members`
- `/v1/orgs/${orgId}/members/${userId}`
- `/v1/orgs/${orgId}/members/${userId}/deactivate`
- `/v1/orgs/${orgId}/members/${userId}/reactivate`
- `/v1/orgs/${orgId}/members/${userId}/roles`
- `/v1/orgs/${orgId}/sso`
- `/v1/orgs/${orgId}/sso/scim-token`
- `/v1/teams`

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
