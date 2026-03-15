# Prisma Query/Recall Cutover Journal

Date: 2026-03-12

## Objective
- Move `/api/memories/query` and `/api/recall` to persisted Prisma-backed retrieval.
- Remove dependence on local process memory cache for stateful query/recall behavior.

## Journal Entries
1. Added persisted retrieval service in `core/src/memory/persisted-retrieval.js`.
2. Implemented query pattern handlers over persisted data:
- `state_of_union`
- `event_time`
- `refinement`
- `inferred_connection`
- `structural_implementation`
- `impact_analysis`
- `evidence`
- `cross_platform_thread`
3. Implemented persisted recall scoring and injection text generation in `recallPersistedMemories`.
4. Extended `PrismaGraphStore` with relationship retrieval for scoped graph traversal.
5. Wired `/api/memories/query` to persisted retrieval when Prisma store is available.
6. Wired `/api/recall` to persisted retrieval when Prisma store is available.
7. Preserved fallback to local engine behavior only when Prisma store is unavailable.
8. Added integration test `core/tests/integration/prisma-query-recall.test.js` for persisted query pattern + recall behavior.
9. Verified integration tests against `hivemind_app`:
- `tests/integration/prisma-memory-store.test.js`
- `tests/integration/prisma-query-recall.test.js`
10. Ran live HTTP smoke validation (host-run server, Prisma DB):
- `POST /api/memories`
- `POST /api/memories/query` (`state_of_union`)
- `POST /api/recall`
11. Confirmed query returns persisted version timeline and recall returns persisted `injectionText`.
12. Removed remaining production retrieval fallbacks in `core/src/server.js` for:
- `GET /api/memories`
- `POST /api/memories/search`
- `POST /api/memories/query`
- `POST /api/recall`
13. Added `REQUIRE_PERSISTED_MEMORY` runtime guard:
- Enabled automatically in `NODE_ENV=production`
- Can be forced in non-production via `HIVEMIND_REQUIRE_PERSISTED_MEMORY=true`
- Returns `503` when Prisma store is unavailable instead of silently using in-memory paths.
14. Hardened prod failure mode for retrieval:
- `POST /api/memories/search` and `POST /api/recall` now return `500` on persisted-store errors in required mode.
- No empty-result fallback response in production-required mode.
15. Enforced persisted-only write path in required mode:
- `POST /api/memories` now fails closed with `503` when Prisma-backed store is unavailable.
- Production can no longer silently write to in-memory fallback.
16. Verified fail-closed behavior with production smoke run:
- Started server with `NODE_ENV=production` and `DATABASE_URL=''`.
- Confirmed `POST /api/memories` returns `503` with persistent-store-required message.
17. Identified DB schema blocker in Prisma-enabled smoke run:
- With Prisma enabled, `POST /api/memories` failed with Prisma `P2022` for missing `organization.data_residency_region`.
- Indicates pending migration/application mismatch in runtime database that must be fixed before production go-live.
18. Resolved local runtime DB split:
- Docker API and integration tests were using `hivemind_app`, while `core/.env` pointed host-run server to stale `hivemind`.
- Updated local host runtime config to point `DATABASE_URL` at `hivemind_app` so host and container exercise the same persisted schema.
19. Verified persisted host runtime end-to-end after config alignment:
- `POST /api/memories` returned `201` and persisted a smoke memory.
- `POST /api/memories/query` (`state_of_union`) returned `200` with current + history from Postgres.
- `POST /api/recall` returned `200` with persisted memory and `injectionText`.
20. Archived stale local database instead of deleting it:
- Renamed `hivemind` to `hivemind_archive_20260312`.
- Active local runtime now targets only `hivemind_app`.
21. Moved `/api/memories/code/ingest` to the Prisma-backed memory engine:
- Added shared code chunk extraction in `core/src/memory/code-ingestion.js`.
- Added `MemoryGraphEngine.ingestCodeMemory()` with persisted `code_memory_metadata` writes.
- Disabled relationship classification for chunked code ingest to avoid false `Updates`/`Extends` between chunks from the same file.
22. Fixed persisted structural code retrieval to use real file path metadata:
- `structural_implementation` and `impact_analysis` now match against `metadata.filepath` / `source_metadata.source_id`, not just `memory.source`.
23. Added persisted code-ingest integration coverage:
- New test `core/tests/integration/prisma-code-ingest.test.js`.
- Verified structural retrieval over Prisma-persisted code memories.
24. Aligned Docker local stack with the same env contract as host runs:
- Added `env_file: ./core/.env` to `api` service in `docker-compose.local-stack.yml`.
- Rebuilt local API container so `localhost:3000` serves persisted code ingest and Groq-backed generation.
25. Verified live Docker API end-to-end on `http://localhost:3000`:
- `POST /api/memories/code/ingest` returned `201`.
- `POST /api/memories/query` (`structural_implementation`) returned `200`.
- `POST /api/recall` returned `200`.
- `POST /api/generate` returned `200` using Groq model `llama-3.3-70b-versatile`.
