# Memory Layer

The memory layer is the foundation of SINGULANCE. HyperAgents and TARA are only
as useful and safe as their recall, ingestion, provenance, and tenant isolation.

## Memory Planes

| Plane | Intended audience | Canonical data location |
| --- | --- | --- |
| `.amr` | Personal users by default; optional supported self-host use | Tenant-scoped `.amr` substrate. |
| Managed hybrid | Managed enterprise | Central PostgreSQL relational memory/graph records plus Qdrant vectors. |
| Self-host hybrid | BYOD enterprise | Customer Box PostgreSQL plus Qdrant; engine resolves it per organization. |

Use one canonical memory substrate per tenant and treat vector search as an
acceleration/retrieval mechanism, not an independent source of truth. JSON
graph artifacts are views/exports, not a second canonical database.

## Ingestion Contract

The write path must preserve:

- authenticated user and resolved organization scope;
- source/provenance and original document/page context;
- idempotency/deduplication behavior;
- explicit extraction/chunking limits and failure states;
- page-based knowledge-base metering: documents, images, and slides count as
  pages where applicable;
- safe retries that do not duplicate customer data or bypass usage gates.

Follow [`docs/architecture/04-pipeline.md`](../docs/architecture/04-pipeline.md),
[`docs/KB_INGESTION_PIPELINE.md`](../docs/KB_INGESTION_PIPELINE.md), and
[`docs/RECALL_PIPELINE.md`](../docs/RECALL_PIPELINE.md).

Do not assume a fixed fact cap or character window is universally safe. Limits
must be measured by source type, page count, extraction quality, queue pressure,
and quota policy. A single document producing many memories can be legitimate;
distinguish expected extraction fan-out from duplicate ingestion, retry loops,
or cross-tenant leakage.

## Recall Contract

Recall must be tenant-scoped before candidate retrieval and remain scoped during
graph expansion, reranking, synthesis, and agent/voice handoff. Results should
retain enough provenance for a user or operator to understand why they appeared.

Performance work starts with measurement:

1. Capture p50/p95 latency and candidate counts for personal `.amr`, managed
   hybrid, and BYOD paths separately.
2. Measure ingestion throughput, queue latency, extraction fan-out, and retry
   rate by source type.
3. Verify the same billing bucket is checked and incremented.
4. Fail closed with a retryable error if a required usage-ledger read cannot be
   trusted.
5. Optimize the actual bottleneck without weakening provenance or isolation.

## Minimum Validation

- Test personal, managed-enterprise, and self-host organization routing.
- Prove no recall/graph/vector result crosses organization boundaries.
- Verify failed ingest cannot leave silently partial or duplicated data.
- Check upload page count and usage enforcement agree.
- Run focused ingestion/recall tests plus a real tenant-scoped document smoke.
