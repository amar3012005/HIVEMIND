# Latest Ingestion Architecture

Last updated: 2026-08-29

## One canonical pipeline

Every source—knowledge upload, connector, meeting, chat-derived save, API, or direct memory save—must enter a canonical envelope and converge at the same memory/entity/relationship intersection. Source adapters may parse differently, but they must not invent independent memory, graph, or vector persistence semantics.

```text
source adapter
  -> canonical ingest envelope
  -> idempotency + authorization + quota admission
  -> existing parser selected by format
  -> sanitize text and JSON metadata
  -> canonical chunking
  -> durable document + evidence segments
  -> ensure tenant vector collection
  -> evidence embedding and indexing
  -> mode gate
       evidence: stop after complete searchable evidence
       both: promote selected canonical memories
  -> canonical entity resolution and projection
  -> evidence-backed typed relationship persistence
  -> provenance/citation links
  -> reconciliation and exact coverage computation
  -> terminal state only when required coverage is complete
```

Do not create a new document-ingestion tree. `hm-extract` is a parser tier, not an ingestion mode. Specialized PDF, DOCX, spreadsheet, and image paths may remain where they preserve page or structural provenance, but all outputs must rejoin the canonical pipeline.

## Mode contract

### Evidence only

- Persist one authorized `KnowledgeDocument`.
- Persist searchable `KnowledgeSegment` evidence.
- Embed/index every required segment.
- Generate zero promoted memories.
- Generate zero memory entities/relationships.
- Report exact evidence coverage and `0 memories`.

### Memories + evidence

- Complete every evidence-only requirement first.
- Select only important, source-supported claims for promotion.
- Target roughly 10–15 useful memories for an ordinary document when quality permits; this is a curation target, not a hard truncation that discards critical information.
- Persist memory type, title, content, source filename/document ID, page/section/span, timestamps, scope, org/user/project ownership, and citation/provenance.
- Resolve important named people, organizations, projects, products, locations, dates, policies, decisions, goals, and other supported entities.
- Persist only evidence-backed typed relationships.

## Current graph/entity policy

Relationships are not generic co-mention noise. Persist durable semantic edges such as `Updates`, `Contradicts`, and `Derives` when evidence supports them. Persist `Extends` only with strong semantic support. Ordinary co-mentions should generally remain searchable metadata rather than permanent graph edges.

For each promoted memory:

- create/reuse canonical entities from the claim and supporting evidence;
- project entity identity into the active storage backend;
- add a bounded set of meaningful edges;
- deduplicate `(from, to, type)`;
- cap weak outgoing edges and defer pruning/maintenance;
- never create a relationship solely because two names appeared in the same extraction batch.

Commit `5fa21505` makes remote projection acknowledgement explicit and fail-closed. It does not solve missed extraction: the newly uploaded document still produced only SINGULANCE/GLOBIA/P&P entities, so a source-grounded Paolo mention—if present—was not projected.

## Durability gates

The job must not become `ready` when any required evidence embedding failed. The current intended gate is:

1. Ensure the tenant collection exists before evidence vector upsert.
2. Track `coverage.evidence_embed.total/succeeded/healed/failed`.
3. Require complete evidence embedding before memory promotion or terminal completion.
4. Keep processing/retrying through reconciliation when recovery is possible.
5. Otherwise expose an honest degraded/failed state; never false-ready.

Upload acknowledgement is asynchronous acceptance only. The UI must poll durable job state and show parser, chunk, embedding, promotion, graph, and reconciliation progress without pretending completion.

## Idempotency and counts

- One logical upload attempt must have one durable idempotency identity.
- A duplicate evidence-only upload requested later as `both` should reuse the document/evidence and promote without rereading or reparsing source bytes.
- Empty duplicate documents must be cleaned only with scoped, dry-run-first tooling.
- Document count counts documents, evidence count counts evidence segments, and memory count counts promoted memories. Evidence must never inflate memory inventory.
- Every count is scoped by authorized organization, user/project, and storage backend.

## What was verified for the incident document

The earlier upload telemetry showed successful parsing/chunking/embedding and promotion for one document. The scoped reconciliation found 15 current document memories and repaired 35 entity links with zero remote projection failures. This proves that the repair path can operate on durable memories without reparsing.

It does not prove entity completeness. Only three canonical source entities were present in the generated memories. The next session must compare raw durable evidence against promoted memories to determine whether important named entities were omitted during extraction or never existed in the uploaded source.

## Next implementation if Paolo exists in the evidence

Fix the canonical intersection, not a source-specific adapter:

1. Preserve named entity mentions in the evidence metadata and promoted claim support.
2. Require the extractor to return important named entities directly supported by the selected evidence spans.
3. Resolve aliases through `CanonicalEntity` and legacy compatibility lookup.
4. Persist the backend-specific entity projection with acknowledgement.
5. Reconcile existing documents from durable evidence/memories without reparsing when possible.
6. Add cross-storage contract tests and an authenticated upload canary.

Do not add hard-coded Paolo, GLOBIA, PDF, or filename rules.

## Production acceptance

For a disposable tenant or explicitly authorized test tenant:

1. Upload exactly one document in evidence-only mode; verify one document, nonzero evidence, zero memories, complete vectors, and grounded evidence recall.
2. Upgrade the same logical document to both mode; verify no duplicate document/evidence, 10–15 curated memories when appropriate, entities, typed relationships, and citations.
3. Ask by exact filename, approximate filename, entity, memory type, relationship, and time.
4. Verify managed, embedded, BYOD, and hybrid result parity.
5. Verify no Prisma UUID/transaction errors, shard-lock errors, false-ready state, proxy 5xx, or noisy per-segment production logs.
6. Clean the synthetic document, vectors, entities, relationships, jobs, and temporary key.

## Local durable Workflow implementation (2026-08-30)

The feature-flagged implementation on `codex/knowledge-ingest-workflow-v1` is
for integration into `singulance-local`; it does not replace production. The
existing multipart request, `202`, polling, terminal, duplicate, scope, and
billing contracts remain unchanged.

Activation requires all three gates:

```text
HIVEMIND_LOCAL_MODE=true
KNOWLEDGE_INGEST_WORKFLOW_ENABLED=true
Flagship knowledge_ingest_workflow_v1=true for the organization
```

The orchestrator and processing version are latched on the job. Cloudflare
messages carry only `job_id`, `org_id`, and `processing_version`. Source bytes
live in the isolated R2 bucket and are verified by ETag and SHA-256.

PostgreSQL records ten successful receipts for a `both` attempt: `acquire`,
`materialize`, `extract`, `persist_evidence`, `embed_evidence`, `evidence_gate`,
`generate_memories`, `project_entities_claims`,
`persist_relationships_citations`, and `reconcile`. The canonical engine remains
the executor. A crash replays its idempotent materialization boundary and heals
missing vectors; finer receipts are persisted verification evidence. Lease
tokens fence late expired workers, and successful receipts reject changed input
within the same processing version.

Local runtime uses production model parity: Gemini 2.5 Flash Lite, the configured
DeepSeek/Groq fallback chain, and BGE-M3 1024-dimensional embeddings through AI
Gateway `hivemind-prod`. Credentials remain environment-only. Chat extraction is
explicitly routed to OpenRouter; BGE embedding/reranking routes are rejected for
chat before network I/O.

Cloudflare-hosted validation uses only Worker
`hivemind-knowledge-ingest-local`, Workflow
`hivemind-knowledge-ingest-workflow-local`, Queue/DLQ
`hivemind-knowledge-ingest[-dlq]-local`, and R2
`hivemind-ingest-artifacts-local`. Its preview bridge is path-bounded,
local-gated, and dedicated-secret authenticated at both hops.

Accepted canaries:

- Evidence-only job `7ae4c69c-8c2c-40a7-b764-e88b156d5c8b`: one document,
  10/10 embedded segments, zero memories, grounded citation.
- Paolo job `cca99f31-fcfd-4707-b0ba-2d84de3f9d9c`: one document, 2/2 embedded
  segments, 10 candidates, 8 memories, 9 citations, ten receipts, and one
  canonical Paolo entity.
- Starting the same hosted deterministic instance twice completed once with
  stable counts. Authenticated recall returned Paolo memories and exact evidence.

Rollback: disable the Flagship flag or set
`KNOWLEDGE_INGEST_WORKFLOW_ENABLED=false`. No production resource or
`singulance-main` release is part of this implementation.

## Production promotion contract (2026-08-30)

The same code path is production-capable, but configuration is deliberately
fail-closed. Production execution requires all of the following:

```text
KNOWLEDGE_INGEST_WORKFLOW_ENABLED=true
KNOWLEDGE_INGEST_WORKFLOW_ENVIRONMENT=production
KNOWLEDGE_INGEST_PRODUCTION_ACK=enable-cloudflare-workflow-v1
NODE_ENV=production
HIVEMIND_LOCAL_MODE is absent or false
Flagship knowledge_ingest_workflow_v1=true for the admitted organization
```

The production Worker uses dedicated `-production` Workflow, Queue, DLQ, and R2
resources. It calls the existing production Core endpoint through the same
secret-authenticated, path-bounded bridge. Model selection, AI Gateway routing,
embedding dimensions, public upload/status payloads, canonical materialization,
tenant authorization, durable checkpoints, and settlement semantics do not
fork between local and production.

Declaring the environment is not production acceptance. A governed promotion
must first create the named resources and secret, deploy an immutable Core image
with the parser/OCR native dependencies, deploy the Worker, and leave Flagship
off by default. It must then enable one disposable tenant and pass authenticated
evidence-only, evidence-to-both, restart/replay, cross-tenant denial, exact-count,
citation, entity, relationship, and recall canaries. Only that evidence permits
a gradual tenant rollout. Existing production resources and settings are not
silently inferred, copied, or overwritten.

## Production hardening v2 (2026-08-31)

The production flag was globally disabled before remediation. The v2 path keeps
browser/API payloads unchanged and changes internal execution as follows:

- Flagship is evaluated once at admission. Queue delivery and Workflow replay
  consume the latched admission and never re-evaluate or drop a job because a
  later flag request failed.
- An explicit flag value of `off` selects the stable BullMQ path. An admission
  transport failure returns 503 and creates no fallback job.
- R2 uploads and durable job creation remain parallel. A PostgreSQL-fenced,
  expiring processing lease admits exactly one heavy production document into
  parser/LLM materialization at a time; waiting Workflows sleep durably.
- `both` mode has real `materialize_evidence` and `promote_memories`
  checkpoints. Promotion reads persisted evidence, so a promotion retry does
  not render, parse, or embed the source again.
- PDF vision OCR and Docling picture descriptions use Cloudflare's direct
  `google/gemini-2.5-flash-lite` REST route with AI Gateway `hivemind-prod`.
  Groq and OpenRouter are not vision fallbacks.
- A failed vision page fails the extraction checkpoint. Provider errors are
  forbidden at the canonical parser boundary and can never become retained
  source text, segments, vectors, memories, or citations.

Rollout order is migration, Core, Worker, flag-off regression, then an explicit
canary. Previously corrupted documents must be reprocessed from original bytes;
the code change intentionally does not mutate old evidence automatically.

