# architect.journal

Running log of design decisions. Newest at top.

## 2026-06-26 — per-org data residency (model)
DECISION: `.amr` replaces Qdrant (vector+graph), NOT Postgres. Memory subgraph → customer PG for
self-host; global user/org/key info → ONE central Postgres. One seam: `getPrismaClient()` split client.
REUSED: existing Prisma + qdrant-client; `pg_dump` of prod for the customer schema.
REJECTED: routing the WHOLE Prisma client per-org (would move User/Org/ApiKey too); `userProfile`/
`clusterIndex` as `.amr` sidecar tables (they're cognitive-layer MEMORIES, not tables); full prod
migrate on customer PG (cross-schema FK ordering — curated 14-table schema instead).
KILL-CONDITION: any feature branching on the backend, or global info landing on a customer box.
HANDOFF: split client + `runWithOrg` + per-org Qdrant + enroll/register + curated schema.
ROLLBACK: unset registry file → all orgs managed (inert).

## 2026-06-27 — Phase 2b: central=0 for remote orgs
- task: stop writing the memory row centrally for orgIsRemote orgs; route reads to the agent. (feature)
- recon: createMemory (prisma-graph-store:305) is the canonical chokepoint; getMemory/getMemories/listMemories read central; mapMemoryRecord output is snake_case ≈ the agent's hm.memories row → small mapAgentRow suffices. currentOrg()+pgUrlFor already imported. Agent /v1/hydrate + /v1/list exist; remoteList missing in remote-backend.
- minimal change (additive, gated):
  1. createMemory: `if (orgIsRemote(memory.org_id)) return;` (skip central row + sourceMetadata + signature — agent gets it via the push).
  2. getMemory/getMemories/listMemories: `if (orgIsRemote(currentOrg()))` → remoteHydrate/remoteList → mapAgentRow.
  3. add remoteList(orgId,filter,cursor,limit) to remote-backend.js.
- flag: orgIsRemote (registry url present). Managed/personal → orgIsRemote=false → central path byte-identical. Context unset → orgIsRemote(undefined)=false → central (fail-safe).
- rejected: per-org pgUrl direct connection (dead Model A). New tables (none).
- rollback: revert the 3 gates + remoteList.
- kill-condition: a managed org's recall/list/ingest changes at all.
