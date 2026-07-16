# Phase 1 — Feature matrix ground truth (2026-06-27)

Test orgs: personal=33db5150 (free,managed) · managed=1eda3825 (enterprise,managed) · selfhost=b30ead1b (enterprise,self_host)
Tested via master key + x-hm-org-id/x-hm-user-id headers.

| Feature | Personal | Managed | Self-host | Notes |
|---|---|---|---|---|
| save memory | ✅ 202 | ✅ 202 | ✅ 202 | all land |
| recall | ✅ | ✅ | ✅ | self-host from agent |
| profile counts | ✅ mem1 | ✅ mem1 | ✅ mem30/rel7 | uniform getOrgCounts |
| central PG residency | n/a (1) | n/a (1) | ✅ 0 | self-host central=0 ✓ |
| **per-tenant vector collection** | ✅ HIVEMIND_PERSONAL | ❌ **GAP-1** | ✅ agent | managed vectors went to HIVEMIND_PERSONAL, NOT org_<id> |
| KB upload (HTTP) | ✅ 200 | ✅ 200 | ⚠️ 200 then async-block | GAP-3 UX |
| KB lands correctly | ✅ central | ✅ central | ❌ blocked (Phase 2) | |

## GAPS found
- **GAP-1 (CRITICAL — user's explicit ask): managed-enterprise vectors write to the shared
  HIVEMIND_PERSONAL pool, not their per-tenant `org_<id>` collection.** `resolveCollectionForOrg(managed)`
  returns `org_1eda3825` correctly standalone, and the write seam (qdrant-client.storeMemory→routeCollection)
  calls it — but at write time the managed vector landed in HIVEMIND_PERSONAL (HIVEMIND_PERSONAL grew to 2
  after 2 managed saves; org_1eda3825 never created). Recall still "worked" via the LEXICAL (PG FTS) leg,
  masking the broken vector isolation. Root: plan-lookup/cache in resolveCollectionForOrg returns personal
  at write time (org.plan read miss / 5-min cache seeded before plan set / transient). → enterprise tenants'
  vectors are co-mingled in the shared pool = isolation bug. FIX FIRST (before Phase 2).
- **GAP-2: self-host org has 21 stale vectors in central qdrant `org_b30ead1b`** (leftover from pre-residency
  testing; NOT growing — new self-host saves go to the agent). Cleanup: delete the central collection.
- **GAP-3: KB upload returns 200 for self-host then the async ingest 501-blocks** — invisible to the user.
  Reject upfront (501) at the upload endpoint for self-host until Phase 2 (KB-on-agent) lands.

## Not yet tested (need setup): connectors (OAuth), meeting notes, HyperAgents room+turn, Web Intel, TARA, MCP, cognition.
