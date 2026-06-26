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
