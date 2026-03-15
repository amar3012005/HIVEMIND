# Explicit Relationship Persistence Journal

Date: 2026-03-13

## Objective

Move live save and ingest flows from implicit or heuristic lineage to explicit persisted `Updates` / `Extends` / `Derives` graph edges where the caller provides relationship intent.

## Implemented

### Direct memory save path

Updated:

- `/Users/amar/HIVE-MIND/core/src/server.js`
- `/Users/amar/HIVE-MIND/core/src/memory/graph-engine.js`

Changes:

- normalized incoming relationship payloads so both `target_id` and `targetId` resolve to the persisted graph engine format
- ensured explicit relationships provided to `POST /api/memories` are passed into `MemoryGraphEngine.ingestMemory(...)`

### Session save path

Updated:

- `/Users/amar/HIVE-MIND/mcp-server/tools/save-session.js`

Changes:

- root session memory now stores explicit `memory_type: event`, `title`, and `source_session_id`
- extracted decisions are persisted as separate memories with explicit `Extends` relationship to the root session memory
- extracted lessons are persisted as separate memories with explicit `Extends` relationship to the root session memory
- fixed response metadata to use the resolved persisted root `memoryId`
- tightened schema-level ISO timestamp validation for session messages and session start/end fields

### Connector ingest path

Updated:

- `/Users/amar/HIVE-MIND/core/src/connectors/mcp/service.js`
- `/Users/amar/HIVE-MIND/src/ingestion/pipeline-orchestrator.js`
- `/Users/amar/HIVE-MIND/src/ingestion/persistence.js`

Changes:

- connector ingest now accepts optional explicit `relationship` input
- normalized jobs inherit explicit relationship intent unless they already define one
- ingestion persistence now forwards `relationship`, `title`, `memory_type`, temporal fields, and source session/message identifiers into the persisted memory writer

## Validation

### Automated

Passed:

- `node --test /Users/amar/HIVE-MIND/mcp-server/tests/save-session.test.js /Users/amar/HIVE-MIND/core/tests/integration/mcp-connector-ingest.test.js`

New integration coverage proves:

- connector ingest can persist an explicit `Extends` edge into Postgres
- session save root payload carries correct event/session metadata

### Live smoke

Rebuilt Docker API and verified on `http://localhost:3000`:

1. created seed memory
2. created child memory with explicit `Extends` relationship
3. API response returned persisted relationship row and `mutation.operation = extended`

## Remaining gap

This completes the explicit relationship persistence step for live save and ingest paths. The next major block is still:

1. version history plus current-state queries
2. graph expansion in recall
