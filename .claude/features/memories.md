# Memories

**Group:** Your Brain · **Route:** `/hivemind/app/memories`
**Status:** RECON DONE — one property verified, no fixes yet, no gates passed.

## Frontend
- `pages/Memories.jsx` — **2,616 lines, the largest page in the app**
- `mobile/MobileMemories.jsx` — separate component, historically staler, audit separately

## Backend endpoints (14 api-client methods)
Everything routes through control-plane `:2027`, which rewrites `/v1/proxy/*` →
`/api/*` and forwards to core `:2026`.

| api-client method | route |
|---|---|
| `listMemories` | `GET /v1/proxy/memories` |
| `getMemory` | `GET /v1/proxy/memories/:id` |
| `deleteMemory` | `DELETE /v1/proxy/memories/:id?hard=true` |
| `getMemoryStats` | `GET /v1/proxy/memory/stats` |
| `getMemoryEvidence` | `GET /v1/proxy/evidence/memory?memoryId=` |
| `hybridSearch` | `POST /v1/proxy/evidence/hybrid` |
| `searchEvidence` | `POST /v1/proxy/evidence/search` |
| `quickSearch` | `GET /v1/proxy/search/quick` |
| `listDocuments` / `getDocument` / `searchDocuments` | shared KB surface |
| `getProfile` | `GET /v1/proxy/profile` |
| `bootstrap` | `GET /v1/bootstrap` |

Dispatcher: `control-plane-server.js:11512`. Forwarder: `proxyToCore()` at `:2459`.

## VERIFIED (1 of 8)
- [x] **The proxy cannot be org-spoofed.** `proxyToCore`
      (`control-plane-server.js:2479-2486`) passes `userId: session.userId` and
      `orgId: session.orgId`, taken from the SESSION and never from request
      headers. A browser cannot select another tenant by setting a header. This
      is the most important property on the page and it holds by construction.

## NOT audited — the actual work, in risk order
- [ ] **`deleteMemory` — highest risk on the page.** Defaults to `hard=true`
      (irreversible). Must prove: a cross-org delete is refused; a repeat delete is
      idempotent, not a 500; a project-scoped memory cannot be deleted by a
      non-member.
- [ ] **Tenant isolation, PROVED.** Two real sessions, two orgs, set-intersect the
      returned ids. Do NOT infer it from the proxy alone — the core handler must
      scope too, and `listMemories` forwards free-form params.
- [ ] **Project boundary.** A project-scoped memory must never surface outside its
      project. The sharpest boundary in the product.
- [ ] **Scope/visibility filtering** across personal / org / project / team on all
      3 live orgs. Precedent: the CHAT scope selector was once a complete no-op
      (3 stacked bugs — FTS lane dropped scope, post-merge filter read the wrapper
      not the memory, scope-less rows kept). Assume nothing here.
- [ ] **Bulk paths** — bulk delete/select idempotency and partial-failure behaviour.
- [ ] **Unbounded output / pagination.** 14 endpoints on one page; measure the
      total load cost and whether a large org returns an unbounded payload.
- [ ] **Empty state** on the 0-memory org (`40da0836` boozit).
- [ ] **Mobile variant.**

## Reproduction
```bash
# control-plane takes a SESSION bearer; core takes a scoped API key.
# X-Org-Id is CORS, NOT auth — see .claude/loop/GOALS.md.
SID=<live cp:session:* from redis>
curl -s "http://127.0.0.1:2027/v1/proxy/memories?limit=5" -H "Authorization: Bearer $SID"
```

## Carried forward from the KB audit
- **~46% of tenants are `amr_embedded`** — their data lives in
  `/app/data/mneme/<orgId>/`, not Postgres. A SQL assertion reports a confident
  FAIL for an org that is working perfectly. Check
  `organizations.memory_storage_mode` BEFORE trusting any query here.
- Live orgs: `807ebb88` MANDI (155), `1380251c` SINGULANCE (~145),
  `40da0836` boozit (0 — the empty-state case).
- Images now produce **memories with no evidence rows** (`48bc9e6b2`), so an
  unanchored image memory on this page is correct, not a defect.
