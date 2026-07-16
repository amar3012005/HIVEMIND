# builder.journal

Running log of implementations. Newest at top.

## 2026-06-26 — context-resolving prisma proxy (B4)
FILES: db/prisma.js, knowledge/document-first-ingestion.js, connectors/framework/sync-engine.js
FLAG/GATE: `getPrismaClient()` returns a stable proxy that re-resolves per property access by the
`runWithOrg()` context. No context / managed org → central (unchanged). Captured `db` now routes per-call.
LOCAL TEST: captured-proxy test → self-host memory→customer PG, user→central, no-ctx→central; conformance 16/16; subgraph 8/8.
DEFAULT PATH: unchanged for managed (resolves to central). KB/connector entries wrapped in runWithOrg.
COMMIT: feat(residency): context-resolving prisma proxy + KB/connector coverage.

## 2026-06-26 — split client (per-org Postgres)
FILES: db/prisma.js (runWithOrg, clientForOrg, makeSplitClient), prisma-proxy.js (export ROUTED_MODELS)
FLAG/GATE: split only for orgs with a registered pgUrl; memory models → customer PG, rest → central.
LOCAL TEST: self-host memory→customer, user/org/apiKey→central; managed→central. conformance 16/16.
COMMIT: feat(residency): split client — memory→customer PG, global info→ONE central Postgres.

## 2026-06-27 — Phase 2b
- files: core/src/memory/prisma-graph-store.js (createMemory skip + getMemory/getMemories/listMemories remote gates + mapAgentRow), core/src/vector/mneme/remote-backend.js (+remoteList).
- flag: orgIsRemote(org)/orgIsRemote(currentOrg()). Default path (managed/personal) untouched.
- local: node --check clean on both files.
