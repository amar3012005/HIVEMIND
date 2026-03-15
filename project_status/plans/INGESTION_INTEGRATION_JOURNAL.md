# Ingestion Integration Journal

Date: 2026-03-12

## Objective
- Move the new async ingestion pipeline off prototype-only local paths.
- Integrate queueing, persistence, and vector indexing with the existing HIVE-MIND production-shaped stack.

## Journal Entries
1. Installed `bullmq` and `ioredis` in the workspace root package so the ingestion queue can use Redis-backed BullMQ mode.
2. Added persisted memory bridge in `src/ingestion/persistence.js`:
- Loads `core/.env` for local runtime parity.
- Dynamically imports `getPrismaClient`, `ensureTenantContext`, `PrismaGraphStore`, and `MemoryGraphEngine` from `core/src`.
- Persists ingestion chunks into Postgres through the Prisma-backed memory engine.
3. Updated `src/ingestion/indexer.js`:
- Added `QdrantVectorStore` for real Qdrant collection creation and point upserts.
- Uses persisted memory IDs as vector point IDs when the persisted writer is available.
- Falls back to in-memory vector store only when Qdrant is not configured.
4. Updated `src/ingestion/pipeline-orchestrator.js` to pass project, source metadata, filepath, tags, and extracted metadata into indexing/persistence context.
5. Updated `src/ingestion/index.js` to allow explicit `memoryWriter` injection for deterministic unit testing while default runtime behavior can use the persisted writer.
6. Updated `tests/ingestion/pipeline.test.js`:
- Injects in-memory vector store + noop memory writer so orchestration unit tests remain isolated and fast.
7. Added `tests/ingestion/persisted-pipeline.test.js`:
- Verifies a code ingestion run persists memories/code metadata into Postgres.
- Verifies a per-user Qdrant collection is created.
8. Removed a hidden runtime trap in CommonJS ingestion files:
- Switched ingestion fetch calls to Node 20 built-in `fetch` instead of `require('node-fetch')`.
9. Validation results:
- `node --test tests/ingestion/pipeline.test.js tests/ingestion/persisted-pipeline.test.js` passed `4/4`.
- Runtime check confirmed `createIngestionPipeline()` initializes in `bullmq` mode.
10. Added public async ingestion API in `core/src/server.js`:
- `POST /api/ingest` enqueues authenticated tenant-scoped ingestion and returns `202` with `jobId`.
- `GET /api/ingest/status?job_id=...` returns stage, attempts, completion state, and final result payload.
11. Fixed canonical code chunking for the persisted code path:
- Updated `core/src/chunker.ast.js` to skip nested relevant nodes already covered by a structural parent.
- Removed broad statement/block nodes that were causing duplicated code text in stored chunks.
- Ensured short-but-valid code samples still emit at least one chunk.
12. Fixed structural queryability for ingestion-produced code chunks:
- Added signature/import extraction in `src/ingestion/chunkers/ast-chunker.js` so ingested code memories can be found by symbol.
13. Aligned Docker runtime packaging for ingestion:
- Added `bullmq` and `ioredis` to `core/package.json`.
- Copied `src/ingestion` into the API image via `core/Dockerfile.dev`.
- Added `src/ingestion/package.json` with `type: commonjs` to avoid ESM/CJS runtime mismatch in the container.
- Added Redis service and API Redis env wiring to `docker-compose.local-stack.yml`.
14. Live validation:
- Host server: `/api/ingest` returned `202`, `/api/ingest/status` returned completed job details, and `/api/memories/query` (`structural_implementation`) returned the ingested code memory.
- Docker server on `http://localhost:3000`: same flow passed end-to-end after Redis/package path fixes.

## Current State
- Queue: BullMQ-backed in real runs, in-memory only when explicitly forced.
- Persistence: Prisma-backed memory engine integration is active for ingestion runs with configured DB.
- Vector indexing: Qdrant-backed in real runs, in-memory only when Qdrant is absent.
- Tests: Both orchestration-only and real persisted integration coverage exist.

## Remaining Gaps
- Relationship classification in the new ingestion path is not yet persisted as a full graph+vector candidate flow; the persisted writer currently prioritizes safe memory writes over aggressive graph mutation.
- AST chunk quality still needs improvement so code chunks are canonical and non-duplicative before heavier retrieval tuning.
- Public ingestion API now exists, but there is still no connector-specific ingest API contract yet (for Gmail/repo/session sources with source-specific validation).
