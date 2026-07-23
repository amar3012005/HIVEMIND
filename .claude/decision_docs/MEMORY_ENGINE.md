# Memory Engine Decision

## Contract

All permitted sources enter one evidence-first canonical ingestion path. Raw
artifacts/documents/segments preserve source truth; only reusable claims become
durable memories. Entities are canonical organization-scoped objects and graph
edges have typed, validated semantics (`Updates`, `Extends`, `Derives`,
`Contradicts`, `PartOf`, `Mentions`).

Recall is metadata-first: authorization, project, explicit document, temporal,
latest/deleted state constrain eligibility before vector/lexical/entity/graph
ranking. `/api/chat` orchestrates the shared recall tools and returns grounded,
server-owned citations. Do not fork this behavior for UI, MCP, TARA, or
HyperAgents.

## Storage

- Managed enterprise: PostgreSQL canonical, Qdrant candidate retrieval.
- Personal: tenant `.amr` slot with equivalent public behavior.
- BYOD: customer-owned Box storage behind the same engine contracts.

Qdrant hits never grant authorization and are never canonical truth.

## Primary Code

- `core/src/knowledge/canonical-ingest.js`
- `core/src/knowledge/document-first-ingestion.js`
- `core/src/memory/recall-router.js`
- `core/src/memory/persisted-retrieval.js`
- `core/src/memory/graph-engine.js`
- `core/src/agent/react-agent-v2.js`
- `core/src/agent/tool-registry.js`

Read `docs/INGESTION_PIPELINE_README.md`, `docs/updated_recall.md`, and
`SINGULANCE-ONBOARD/MEMORY-LAYER.md`. Validate every changed source adapter,
backend, scope, citation, deletion, and restart path.
