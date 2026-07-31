# HyperAgents Rooms + Runtime

**Group:** Operating System · **Route:** `/hivemind/app/employees`
**Status:** UNAUDITED — no production review yet

## Frontend
- `pages/HyperAgents.jsx`
- `pages/DigitalEmployees.jsx`
- `pages/EmployeePlayground.jsx`

## Backend endpoints called (45)
- `/v1/campaigns`
- `/v1/campaigns/${id}`
- `/v1/campaigns/${id}/${action}`
- `/v1/campaigns/capabilities`
- `/v1/campaigns/connections`
- `/v1/campaigns/connections/ad-accounts/select`
- `/v1/campaigns/connections/connect`
- `/v1/campaigns/connections/disconnect`
- `/v1/campaigns/connections/provision`
- `/v1/campaigns/connections/sync`
- `/v1/campaigns/settings`
- `/v1/employees`
- `/v1/employees/${employeeId}/remint-key`
- `/v1/employees/${id}`
- `/v1/employees/${id}/deploy`
- `/v1/employees/${id}/pause`
- `/v1/employees/${id}/resume`
- `/v1/employees/${id}/tune`
- `/v1/employees/${slug}/chat`
- `/v1/employees/optimize-persona`
- `/v1/hyper-rooms`
- `/v1/hyper-rooms/${roomId}`
- `/v1/hyper-rooms/${roomId}/approve`
- `/v1/hyper-rooms/${roomId}/call`
- `/v1/hyper-rooms/${roomId}/connectors`
- `/v1/hyper-rooms/${roomId}/hq-activity`
- `/v1/hyper-rooms/${roomId}/turns`
- `/v1/hyper-rooms/${roomId}/turns/${turnId}`
- `/v1/hyper-rooms/${roomId}?hard=true${force`
- `/v1/hyper/company`
- `/v1/hyper/domain-rooms/ensure`
- `/v1/hyper/growth-baseline`
- `/v1/hyper/growth-baselines`
- `/v1/hyper/growth-operating-state`
- `/v1/hyper/growth-plans`
- `/v1/orgs/${orgId}/employees/remint-all-keys`
- `/v1/projects`
- `/v1/proxy/connectors/connect`
- `/v1/proxy/connectors/connect-session`
- `/v1/proxy/connectors/status`
- `/v1/proxy/seo/search-console/status`
- `/v1/proxy/web/jobs${qs`
- `/v1/team-tasks`
- `/v1/team-tasks/${taskId}`
- `/v1/team-tasks/${taskId}/transcript`

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
