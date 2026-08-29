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

