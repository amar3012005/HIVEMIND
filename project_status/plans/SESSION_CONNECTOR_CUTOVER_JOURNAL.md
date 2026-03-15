# Session Connector Cutover Journal

Date: 2026-03-12

## Objective
- Move the MCP `save_session` connector off direct `/memories` writes.
- Route session capture through the new async persisted ingestion path.
- Prove the saved session is queryable through persisted retrieval.

## Journal Entries
1. Updated `mcp-server/tools/save-session.js`:
- Main session save now uses `POST /api/ingest`.
- Polls `GET /api/ingest/status?job_id=...` until completion.
- Falls back to persisted search resolution when the ingest result does not directly expose a `memoryId`.
2. Normalized session connector HTTP payloads to the current persisted API contract:
- Uses `/api/memories` instead of stale `/memories`.
- Uses snake_case request fields for persisted memory writes.
3. Updated ingestion pipeline result payload:
- `src/ingestion/pipeline-orchestrator.js` now includes `memory_ids` in completed ingest results.
4. Updated save-session tests:
- Mock API now supports `/api/ingest`, `/api/ingest/status`, `/api/memories`, and `/api/memories/search`.
- `node --test mcp-server/tests/save-session.test.js` passed with `38` tests passing and `3` skipped Groq-dependent tests.
5. Live end-to-end verification against the running API:
- Invoked `handleSaveSession(...)` against `http://localhost:3000`.
- Confirmed returned `metadata.memoryId` is non-null.
- Confirmed persisted query (`pattern: evidence`) returns matching session memories.
- Confirmed persisted recall returns the saved session in `injectionText`.

## Outcome
- The chat/session connector is no longer just “tool logic”.
- It now writes through the same async persisted ingestion surface as the rest of the platform.
- Session memories are queryable through the production-shaped retrieval path.

## Remaining Gaps
- Decision/lesson extraction still depends on Groq availability for full coverage in live runs.

## Follow-Up: Claude Desktop MCP Transport Fix
6. Investigated Claude Desktop parse failures after a successful `save_session` run:
- Claude showed `Unexpected token ... is not valid JSON` errors after the tool completed.
- Root cause was MCP transport contamination from runtime `console.*` logging and a Node `MODULE_TYPELESS_PACKAGE_JSON` warning.
7. Hardened MCP logging:
- Added `mcp-server/safe-logger.js` to route runtime diagnostics to `/tmp/hivemind-mcp.log`.
- Replaced stdio logging in `mcp-server/server.js`, `connectors/chat/summarizer.js`, `connectors/chat/extractor.js`, and `core/src/mcp/sync.js`.
- Removed the startup banner and sync connection prints from MCP stdio.
8. Removed the Node ESM warning source:
- Added top-level `"type": "module"` in `package.json`.
9. Re-validated MCP transport behavior:
- Isolated `node mcp-server/server.js` startup now emits `0` bytes to stdout and `0` bytes to stderr.
- Claude Desktop was restarted after the patch and confirmed to relaunch `/Users/amar/HIVE-MIND/mcp-server/server.js`.
10. Verified persisted session storage:
- Persisted search and recall both returned Claude session memories from project `session-memory`.
- Confirmed a Claude session saved at `2026-03-12T22:38:39.107Z` is present in the database-backed retrieval path.

## Follow-Up: MCP Memory Save Contract Fix
11. Investigated `save_memory` failures from Claude Desktop:
- MCP tool returned `Unknown error` while saving a basic fact memory.
- Root cause was a stale MCP-to-API contract. `mcp-server/server.js` still called legacy routes like `/memories` and `/recall`, while the live backend serves `/api/memories` and `/api/recall`.
12. Updated MCP server contract handling:
- `save_memory` now posts to `/api/memories` using `memory_type`, `importance_score`, and `source_platform`.
- `recall`, `list_memories`, `search_memories`, and `traverse_graph` now use `/api/*` paths and current field names where applicable.
- `apiCall()` now falls back to raw response text when JSON parsing fails, so plain-text 404s no longer surface as `Unknown error`.
13. Live verification:
- Replayed the reported NVIDIA/Linux memory payload against `/api/memories` successfully.
- Confirmed persisted save with memory id `401a2f5a-f752-41da-9761-5ef9a3b0ae4e`.
- Search returned the new memory through the persisted retrieval path.
