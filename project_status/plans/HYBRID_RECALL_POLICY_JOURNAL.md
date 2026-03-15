# Hybrid Recall Policy Journal

Date: 2026-03-13

## Objective
- Add project/source-aware recall defaults to Claude MCP and Codex flows.
- Move persisted recall from keyword-only scoring to hybrid vector + graph + policy ranking.
- Validate the result with Codex memory and a Gmail-shaped memory.

## Changes
1. Expanded persisted recall inputs in `core/src/server.js`:
- `/api/recall` now forwards:
  - `source_platforms`
  - `tags`
  - `preferred_project`
  - `preferred_source_platforms`
  - `preferred_tags`

2. Added direct Qdrant indexing for persisted `/api/memories` writes:
- `core/src/server.js` now stores newly persisted memories into per-user Qdrant collections.

3. Upgraded Qdrant client behavior in `core/src/vector/qdrant-client.js`:
- Supports explicit `collectionName` overrides.
- Stores `source` and `source_platform` in payloads.
- Uses a 1536-dim contract aligned with the ingestion pipeline.

4. Fixed Mistral embedding request shape in `core/src/embeddings/mistral.js`:
- Changed embeddings request body from `inputs` to `input`.
- Normalizes embedding vectors to 1536 dimensions.

5. Replaced persisted recall scoring in `core/src/memory/persisted-retrieval.js`:
- lexical candidates from Prisma
- vector candidates from Qdrant
- graph boost from relationship counts
- policy boost from preferred project/source/tags
- dedupe and relevance floor retained
- returns score breakdown:
  - `vector_score`
  - `keyword_score`
  - `graph_score`
  - `policy_score`
- returns `search_method: persisted-hybrid` when vector search participates

6. Added default recall preferences to client flows:
- `mcp-server/server.js`
  - `HIVEMIND_DEFAULT_RECALL_PROJECT`
  - `HIVEMIND_DEFAULT_RECALL_SOURCES`
  - `HIVEMIND_DEFAULT_RECALL_TAGS`
- `scripts/codex-hivemind.js`
  - `HIVEMIND_DEFAULT_PROJECT`
  - `HIVEMIND_DEFAULT_RECALL_SOURCES`
  - `HIVEMIND_DEFAULT_RECALL_TAGS`
  - optional flags:
    - `--project`
    - `--source`
    - `--prefer-source`
    - `--prefer-tag`

7. Added integration coverage in `core/tests/integration/prisma-query-recall.test.js`:
- duplicate filtering
- low-signal session suppression
- Gmail source preference and project scoping

## Live Validation
1. Codex wrapper:
- saved fresh Codex memory in project `codex-hybrid-test`
- recalled it successfully with scoped wrapper flow

2. Gmail-shaped memory:
- normalized through `core/src/connectors/gmail.connector.js`
- flattened to the persisted `/api/memories` contract for the smoke test
- saved successfully with source `gmail`
- created an `Extends` edge to an earlier Gmail memory
- recall result returned:
  - the Gmail memory as top hit
  - `search_method: persisted-hybrid`
  - non-zero `vector_score`, `graph_score`, and `policy_score`

## Remaining Gap
- The Gmail connector still needs a first-class public ingest surface so normalized connector output can be posted directly without flattening it to the `/api/memories` request contract in test code.
