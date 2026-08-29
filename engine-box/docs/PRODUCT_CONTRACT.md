# Engine Box v1 product contract

Engine Box is a **local memory appliance**, not a repackaged hosted
HIVEMIND installation. It owns its local PostgreSQL, Qdrant, Redis, documents,
evidence, memories, provenance, model routes, chat and memory MCP endpoints.
The hosted product does not receive document text, prompts, answers, embeddings
or extracted metadata unless a tenant administrator explicitly enables a route
whose signed model-catalogue entry declares content egress.

## Product boundary

| Included locally | Explicitly excluded |
| --- | --- |
| evidence and `both` ingestion, `hm-extract`, supported specialised parsers | TARA, voice and audio assistants |
| embedding, indexing, reranking, hybrid/temporal/graph recall | Employees, connectors and action workflows |
| grounded local chat and memory MCP | HyperAgents, web search and agent orchestration |
| local admin, OIDC/RBAC, APIs, export, erasure and backups | hosted product data stores as a required dependency |

The Core image must set `ENGINE_BOX_MODE=true` before it loads application
modules. Any requested excluded capability is a boot failure. New hosted
features are opt-in only after they have a local owner, a parity contract test,
and a data-egress classification.

## Stable local API

All paths below are versioned independently from hosted HIVEMIND. Except for
`/health` and `/ready`, they require customer OIDC or a scoped local machine
credential.

```text
GET  /health                         liveness only
GET  /ready                          READY | DEGRADED | UNAVAILABLE
POST /v1/knowledge/upload            multipart upload, `ingest_mode=evidence|both`
GET  /v1/knowledge/jobs/:id          persisted stage, units, percent, elapsed
POST /v1/recall                      typed RetrievalSpec
POST /v1/chat                        grounded non-streaming chat
GET  /v1/chat/stream                 grounded SSE chat
POST /mcp                            local memory-engine MCP transport
POST /v1/gdpr/export
POST /v1/gdpr/erase
GET  /v1/admin/status
POST /v1/admin/update
POST /v1/admin/rollback
```

## Ingestion invariants

```text
upload → admission/idempotency → parser selection → canonical chunking
       → metadata sanitisation → evidence persistence → embedding/indexing
       → optional curated memory promotion → provenance/relationship writes
```

- `evidence`: one Document and its Evidence segments; zero Memories.
- `both`: the same Document/Evidence plus up to 15 selected high-value Memories.
- Every segment and promoted memory records document ID, file name, range/page,
  checksum, uploader and organisation IDs, source, timestamps, excerpt, model
  route and derivation/citation data.
- Repeating the same idempotency key or content checksum is a repair/resume,
  never a duplicate-document operation.

## RetrievalSpec contract

One executor serves REST, chat, MCP and temporal tools. It authorises and
filters independent Memory and Evidence lanes in parallel before ranking.

```json
{
  "query": "Kruti",
  "scope": { "organization_id": "required", "project_id": "optional" },
  "subject": { "entities": ["Kruti"], "document_ids": [], "source_filenames": [] },
  "intent": "relevant | latest_mention | latest_event | as_of | timeline | diff",
  "memory_types": [],
  "relationship_types": [],
  "time": { "known_at": {}, "event_time": {}, "valid_at": {} },
  "limit": 15
}
```

Hard filters are tenant/scope, type, entity, source/document, layer,
relationship, time and version eligibility. Ordering is stable: ordinary
`relevance DESC, known_at DESC, id ASC`; latest mention `known_at DESC,
relevance DESC, id ASC`; latest event `event_time DESC, known_at DESC, id ASC`.
Historical requests select the latest version eligible at their boundary.

## Egress and models

The signed model catalogue names its capability, execution location, provider,
protocol, embedding dimension, hardware requirement, egress classification,
compatible fallback group and health probe. `local` and `customer_gateway`
routes are sovereign defaults. A `cloudflare_gateway` route is rejected unless
the tenant has recorded current consent matching the catalogue version.

## Status and failure policy

`READY` requires all local data-plane services and a configured usable model
route. `DEGRADED` means safe reduced operation (for example an expired lease in
read-only mode); `UNAVAILABLE` means a required local dependency is absent.
Failures are explicit: an unavailable vector/reranker route may not become a
fabricated empty recall response.

Central telemetry is limited to installation ID, release/schema version,
readiness, heartbeat, aggregate counts, licence and update state. It does not
accept customer content fields. Tunnel connectivity is outbound-only and never
controls normal local operation.
