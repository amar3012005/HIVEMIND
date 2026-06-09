# Knowledge-Base Ingestion Pipeline

> **Scope.** End-to-end reference for HIVEMIND's document-first KB ingestion: how an
> uploaded file (or a connector record) becomes evidence → structure → canonical
> memory, every stage, every fallback, every timeout/env knob, the per-user lock,
> the concurrency model, and the observability hooks.
>
> **Primary source files**
> - `core/src/server.js` — `/api/knowledge/upload` route, `doclingAdapter` tier wrapper, `/api/knowledge/status`
> - `core/src/knowledge/document-first-ingestion.js` — `DocumentFirstIngestionService` (the pipeline)
> - `core/src/knowledge/enterprise/docling-adapter.js` — Docling sidecar HTTP wrapper
> - `core/src/memory/graph-engine.js` — canonical `ingestMemory` gateway + `linkEntitiesForMemories`
> - `core/src/memory/smart-ingest-router.js` — source-type routing + triple-operator inference
> - `core/src/memory/prisma-graph-store.js` — Postgres write layer + per-user advisory lock

---

## 1. Three layers

KB ingestion is built around three durable layers. Nothing is thrown away — a
canonical memory always traces back to the exact bytes it came from.

```
┌──────────────────────────────────────────────────────────────────────┐
│  EVIDENCE LAYER  (immutable, raw)                                      │
│  source_artifacts   — raw upload bytes + sha256 checksum (dedup key)   │
│  knowledge_documents — one row per parsed file                         │
│  knowledge_segments  — structure-aware chunks (heading-rooted)         │
│  + Qdrant evidence vectors (payload.layer = 'evidence')                │
└──────────────────────────────────────────────────────────────────────┘
                              │  selective promotion
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│  MEMORY LAYER  (canonical, recall-visible)                             │
│  memories            — promoted, deduped, operator-classified          │
│  memory_evidence_links — memory → segment provenance (linkType=supports)│
│  memory_derivations   — how the memory was produced                    │
│  relationships        — PartOf (child→document), Updates, Extends, …   │
│  + Qdrant memory vectors (recall search space)                         │
└──────────────────────────────────────────────────────────────────────┘
                              │  hourly drift compaction
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│  COGNITIVE LAYER  (see MEMORY_COGNITION_LIFECYCLE.md)                   │
│  canonical-summary memories, entity topic-state, governance            │
└──────────────────────────────────────────────────────────────────────┘
```

**Why a separate evidence layer?** Promotion is *lossy and selective* (only ~5–20
segments of a big doc become memories). The full document survives in
`knowledge_segments` + evidence vectors so the cognition loop, "show me the
source" UI, and lazy fact-extraction can always reach the original text.

---

## 2. End-to-end flow (happy path)

```
FE / API caller
   │  POST /api/knowledge/upload   (multipart; async=true recommended)
   ▼
[server.js route]  validate type/size → resolve scope (project/team) → quota check
   │
   ├─ async=true → create job (ingestTracker), return 202 {job_id}, run in bg
   └─ sync       → run inline, return final result
   │
   ▼
DocumentFirstIngestionService.ingestKnowledgeDocument()
   │
   1. sourceArtifact.upsert        (checksum dedup — identical re-upload is a no-op)
   2. _parseDocument → doclingAdapter.parseBuffer   (tiered; see §4)
   3. knowledgeDocument.upsert     (sourceId = filename#<hash12>)
   4. _createSegments              (Docling hybrid chunks → structured; else sliding window)
   5. _embedSegments               (Qdrant, layer=evidence)  [first-time only]
   6. _extractEntitiesAsync        (fire-and-forget per-segment entity extraction)
   7. _promoteMemories             (diversity-sample → route → ingestMemory → links)  ← the hot path
        └─ linkEntitiesForMemories (DEFERRED, concurrent, post-commit)  ← perf win (§6)
        └─ Document parent + PartOf edges
   │
   ▼
ingestTracker.updateJob(status: 'indexed', progress: 100)
   ▲
FE polls GET /api/knowledge/status?job_id=…  until status === 'indexed'
```

The `[phase1-timing]` log line at the end of step 7 is the canonical per-upload
profile:

```
[phase1-timing] parse=4ms seg=4308ms embed=4257ms promote=21361ms segs=24 memories=21
```

---

## 3. Entry points

| Entry | Method | When | Docling? |
|-------|--------|------|----------|
| `ingestKnowledgeDocument` | `POST /api/knowledge/upload` | User/API file upload | Yes (tiered) |
| `ingestEnterpriseDocument` | upload with `enterprise=true\|auto` + schema | Structured docs (invoices, contracts) | Yes + schema extract |
| `ingestConnectorRecord` | sync-engine (Slack/Notion/GitHub/Linear/Jira/Confluence) | Connector sync | No — adapter already gave text |

All three converge on the same `_embedSegments` + `_promoteMemories` core. Only
the parse/segment front-end differs.

### 3.1 Upload route contract (`/api/knowledge/upload`)

Multipart form fields (all optional except the file):

| Field | Meaning |
|-------|---------|
| *(file part)* | the document; ≤ 100 MB; type allow-list below |
| `async` | `"true"` → return `202 {job_id}` + background process (recommended for big docs). Also via `?async=true` query |
| `targetScope` | `"organization"` → org-visible; else personal |
| `tags` | comma-separated user tags |
| `projectId` / `projectIds` | scope promoted memories to project(s) |
| `containerTag` | project slug/name (upload-scope modal sends slug here; resolved → project id) |
| `primaryTeamId` | scope to a team |
| `smart` | `"true"` → force Docling smart-mode (OCR, table structure, enrichment) |
| `picture_descriptions` | `"true"` → Groq VLM figure captions (smart only) |
| `enterprise` | `auto` (default) \| `true` \| `false` — schema extraction |

**Allowed types:** PDF, DOCX/DOC, XLSX/XLS, PPTX/PPT, TXT, MD, CSV/TSV, HTML,
PNG/JPG/TIFF/WEBP, MP3/WAV/M4A/FLAC/OGG. Checked by both MIME and extension.

**Pre-flight quota:** rough page estimate (`bytes/50KB`) checked against
`planEnforcer` `kbPages` budget → `402 page_budget_exceeded` if over. Exact pages
recorded after parse.

### 3.2 Async lifecycle (FE poll)

1. `POST …?async=true` → `202 { job_id, status: "queued" }` + `X-Job-Id` header.
2. Server runs the pipeline in a detached async IIFE, streaming per-stage progress
   into `ingestTracker` (`parsing` 10 → `parsed` 35 → `embedded` 70 →
   `promoting` 80 → `promoted` 95 → `indexed` 100).
3. FE polls `GET /api/knowledge/status?job_id=<id>` (falls back to
   `?document_id=<id>` for durability across restart/expiry — reads
   `knowledgeDocument.parseStatus`).
4. FE stops when `status === 'indexed'` (or `'failed'`). Client deadline ~10 min.

---

## 4. Parse: the tiered Docling adapter

`doclingAdapter.parseBuffer(buffer, { filename, contentType, smart, picture_descriptions })`
in `server.js` writes the buffer to a temp file and picks a tier by extension.
Each tier returns `{ text, markdown, hybridChunks[], engine, error }`. Order:

| Tier | Trigger | Engine | Notes |
|------|---------|--------|-------|
| **whisper** | mp3/wav/m4a/ogg/flac + `GROQ_API_KEY` | `groq-whisper` | one chunk per Whisper segment (timestamps preserved); 180s timeout |
| **plain-text** | txt/md/markdown/html/htm | `plain-text` | **skips Docling entirely** — splits on markdown headings (`#…######`) else 1500-char windows (200 overlap). ~1ms. |
| **image-vision** | png/jpg/tiff/webp + `GROQ_API_KEY` | `groq-image` | single bitmap OCR; falls through to Docling on failure |
| **csv** | csv/tsv | `csv-direct` | row-as-segment, `header: value` lines, no LLM |
| **Tier 1 fast-pdf** | pdf **and not** `smart` | `pdf-parse` | text-native PDFs (1–2s). Page-aware chunking via `-- N of M --` markers; noise-filtered headings |
| **Tier 3 groq-vision** | pdf + `isImageHeavy` + `GROQ_API_KEY` | `groq-vision` | scanned/image PDFs |
| **Tier 2 Docling** | smart=true (enterprise) or other office formats | `docling` | parallel `parseWithDocling` + `chunkWithDocling`; OCR, table structure, enrichment |
| **fallback** | Docling failed/empty on a PDF | `docling-fallback-fastpdf` | never lose the upload |
| **fallback** | all else fails | `fallback` | raw utf-8 read |

### Docling sidecar (`docling-adapter.js`)

- Service at `DOCLING_URL` (default `http://docling:5001`). Endpoints used:
  `/v1/convert/file`, `/v1/convert/file/async` + `/v1/status/poll/:id` +
  `/v1/result/:id`, `/v1/chunk/hybrid/file`.
- **Async-or-sync:** files > 4 MB or `smart` go through the async submit+poll API
  (sync wait caps internally). Overall ceiling: **180s smart / 120s non-smart**;
  beyond that → fast-pdf Tier 1 fallback.
- **Hybrid chunker** (`/v1/chunk/hybrid/file`): `max_tokens=512` (matches BGE-M3
  context), `merge_peers=true`, `repeat_table_header=true` → each chunk carries
  `headings[]`, `page`, `num_tokens`.
- **`collapseLetterSpacing()`**: strips NUL/control bytes Postgres can't store and
  collapses letter-spaced runs (`G E M E I N` → `GEMEIN`) that otherwise poison
  embeddings and titles. Min-5 letter-only constraint protects tabular/numeric data.

---

## 5. Structure → memory

### 5.1 Segments (`_createSegments`)

- **Preferred:** Docling hybrid chunks → `segmentType: 'structured'`, carrying
  `heading` (joined `›`), `page`, `depth` (heading nesting), linked-list
  `previousSegmentId`. Chunks < 20 chars dropped.
- **Fallback:** sliding window — 1000-char chunks, 200 overlap, `segmentType:'chunk'`.
- Idempotent: re-upload of identical content reuses existing segments (no re-embed).

### 5.2 Embedding (`_embedSegments`)

- Embeds each segment, upserts to Qdrant with `payload.layer = 'evidence'`.
- Per-tenant mode (`QDRANT_PER_TENANT`): evidence + memory share the org container;
  `layer=evidence` keeps segments out of memory recall. Legacy: dedicated
  `hivemind_evidence` collection (`EVIDENCE_QDRANT_COLLECTION`).
- Marks `knowledgeSegment.vectorStored = true`. Only runs on first-time creation.

### 5.3 Promotion (`_promoteMemories`) — the core

**Diversity-sampled selection** (not "promote everything"):

1. Always include first + last segment (document boundaries).
2. Always include every distinct-heading segment (Docling structure).
3. Even-spaced sampling to fill up to `MAX_PROMOTE` (default 20).
4. Dedup by `(heading + content-prefix)` so single-H1 docs aren't squashed.
   `MIN_PROMOTE` (default 5): docs ≤5 segments promote whole.

For each selected segment (`promoteOne`):

```
build payload (scope, title=heading|first-sentence, filename:/doc-hash:/doc-id:/heading:/page: tags)
   │   skip_fact_extraction = true when ≥30 segments (big-doc latency guard; lazy later)
   │   strict_contradictions = true (KB: fire only on real value-change, sim≥0.65)
   ▼
smartIngestRouter.route(payload)            → routedPayloads[]  (operator inference)
   ▼
for each routed:
   memoryGraphEngine.ingestMemory({ ...routed, defer_entity_linking: true })   ← per-user lock held here
   verify row exists (defense vs FK race)
   push to memories[] AND entityLinkTargets[]
   memoryEvidenceLink.create  (memory→segment, linkType=supports, conf 0.9)
   memoryDerivation.create    (method=promoted_from_segment)
   _linkEntitiesToMemoryAsync (mirror segment entity_mentions onto memory)
```

**Concurrency:** `PHASE1_PROMOTE_CONCURRENCY` workers (default **4**) pull from a
shared index over the selected segments.

After all workers finish:

- **Deferred entity-linking** (§6) fires concurrently, off the lock.
- **Document parent node**: a `document-summary` memory is created (title + section
  count + first 280 chars, no LLM, `skipPredictCalibrate` so it never dedups), and
  every promoted child gets a `PartOf` edge → parent (falls back to
  `Extends` + `metadata.subtype='PartOf'` if the running Prisma client predates the
  enum migration). Net shape: **1 Document + N Sections + N PartOf edges**.

---

## 6. The per-user lock & the parallelization win

### The lock

Every `ingestMemory` acquires a **per-user Postgres advisory lock**
(`acquire_memory_user_lock`) plus an in-process promise-chain mutex, so all writes
for one user are serialized (prevents duplicate/racey dedup decisions). The locked
critical section therefore gates promotion throughput.

### What was wrong (pre-fix)

The per-user lock was held across `_attachEntityCoMentionEdges` — a
`llama-3.3-70b-versatile` Groq call (~2s/memory) that ran **inside** the lock for
every promoted segment. Two failure modes:

1. **Wedge:** the Groq `fetch` had **no timeout** → a hung call held the lock
   indefinitely → promote stalled > 10 min → FE showed *"Ingestion timed out."*
   Fixed in `10b05ae` by bounding both entity-link fetches with
   `AbortSignal.timeout(ENTITY_LINK_TIMEOUT_MS, default 25000)`.
2. **Serial tax:** even when healthy, 2s × N segments ran serially under the lock.
   A 24-chunk doc → ~44s in promote alone.

### The fix (`04c49cf`)

Entity-co-mention linking is **deferred out of the lock** to a concurrent
post-commit pass:

- `graph-engine.ingestMemory` now gates the in-lock call:
  ```js
  if (!input.defer_entity_linking) {
    await this._attachEntityCoMentionEdges(baseMemory, store, recallSimilar);
  }
  ```
  The locked section shrinks to **DB write + conflict check (~100ms)**.
- New `graph-engine.linkEntitiesForMemories(memories, { concurrency })`: a bounded
  worker pool that runs `_attachEntityCoMentionEdges` for all promoted memories
  **after** they commit, with **no per-user lock**.
- `_promoteMemories` collects `entityLinkTargets[]` during the locked loop, then
  fires `linkEntitiesForMemories` fire-and-forget once all segments commit:
  ```
  [entity-link:deferred] linked 20 promoted memories
  ```
- `PHASE1_PROMOTE_CONCURRENCY` raised 2 → 4 (safe now the lock queue drains fast,
  no P2010 transaction-timeout risk).

**Result (24-chunk doc, measured):** promote **44.6s → 21.4s**, total **48s → 25.7s**.
The 2s/segment LLM cost is fully off the critical path — for 100s-of-chunk docs the
win compounds (linking happens concurrently while the upload already reports
`indexed`; `entity:*` tags + co-mention edges land shortly after, same
eventual-enrichment posture as `_extractEntitiesAsync`).

> **Posture note.** Entity tags/edges are now *eventually* consistent (seconds after
> `indexed`), not synchronous. Recall by entity tag on a just-uploaded doc may lag a
> few seconds. This is intentional and matches the existing async entity-extraction
> path.

---

## 7. Environment variables

| Var | Default | Effect |
|-----|---------|--------|
| `ENABLE_DOCUMENT_FIRST_INGEST` | — | must be `true` to enable the pipeline |
| `DOCLING_URL` | `http://docling:5001` | Docling sidecar; absent → fallback parsers only |
| `PHASE1_MAX_PROMOTE` | `20` | max segments promoted per doc |
| `PHASE1_MIN_PROMOTE` | `5` | docs ≤ this promote whole |
| `PHASE1_PROMOTE_CONCURRENCY` | `4` | parallel promotion workers |
| `PHASE1_ENTITY_LINK_CONCURRENCY` | `6` | parallel deferred entity-link workers |
| `ENTITY_LINK_TIMEOUT_MS` | `25000` | per entity-co-mention Groq fetch timeout |
| `MEMORY_ENTITY_LINKING` | `true` | `false` disables entity-co-mention entirely |
| `ENABLE_ENTITY_EXTRACTION` | — | `true` enables per-segment entity extraction |
| `ENTITY_EXTRACT_CONCURRENCY` | `6` | parallel segment entity-extraction workers |
| `DOCLING_CHUNK_MAX_TOKENS` | `512` | hybrid chunker token budget (match embedder) |
| `DOCLING_OCR_LANGS` | `de,en` | smart-mode OCR languages |
| `DOCLING_PDF_BACKEND` | `dlparse_v4` | smart-mode PDF backend |
| `EVIDENCE_QDRANT_COLLECTION` | `hivemind_evidence` | legacy evidence collection name |
| `QDRANT_PER_TENANT` | — | `true` → evidence + memory in per-org container |
| `EMBEDDING_DIMENSION` | — | honored by embedder |
| `GROQ_API_KEY` | — | unlocks whisper / image-vision / vision-PDF / picture-desc tiers |

Timeout ceilings (hard-coded): Docling smart 180s / non-smart 120s; async submit
60s; whisper 180s; hybrid chunker 180s.

---

## 8. Observability

Grep these on `hm-core` / `hm-core-2`:

| Log | Meaning |
|-----|---------|
| `[knowledge] Using Phase 1 document-first ingestion for <file>` | route entered |
| `[docling-adapter] tier=<t> file=<f> … ms=<n>` | which parse tier ran + latency |
| `[segments] hybridChunks=<n> parseText=<n>ch` | segmentation source |
| `[phase1-timing] parse=… seg=… embed=… promote=… segs=N memories=M` | **per-stage profile** |
| `[entity-link:deferred] linked N promoted memories` | deferred linking completed |
| `[entity-co-mention] entities=[…] links=N` | a single memory's co-mention pass |
| `[knowledge:async] ✓ <file> doc=… segs=… promoted=… ms=…` | async job done |
| `emit('promoted', …)` drop counter | `segments → candidates → promoted` (surfaces silent loss) |

---

## 9. Data model (KB tables)

| Table | Key columns | Role |
|-------|-------------|------|
| `source_artifacts` | `userId,orgId,checksum,sourcePlatform` (unique) | immutable raw bytes; checksum = dedup key |
| `knowledge_documents` | `sourceId = filename#<hash12>`, `parseStatus`, `parseEngine`, `wordCount` | one per parsed file |
| `knowledge_segments` | `documentId`, `segmentIndex`, `segmentType`, `content`, `contentHash`, `metadata.heading/page`, `vectorStored` | structure-aware chunks |
| `memories` | `scope`, `project_ids`, `tags`, `is_latest` | promoted canonical memory |
| `memory_evidence_links` | `memoryId→segmentId`, `linkType='supports'`, `excerpt` | provenance |
| `memory_derivations` | `derivationMethod='promoted_from_segment'` | how it was made |
| `relationships` | `from_id,to_id,type` (PartOf/Updates/Extends), `created_by` | graph edges |

---

## 10. Tuning for very large docs (100s of chunks)

1. **Always use `async=true`** — the sync path blocks the request; async returns a
   job id instantly and the FE polls.
2. `PHASE1_MAX_PROMOTE` caps how many segments become memories regardless of doc
   size. Raise it for high-value docs (each promoted memory costs ~100ms lock +
   one deferred LLM call); lower it for noisy docs.
3. `PHASE1_PROMOTE_CONCURRENCY` (lock-bound write fan-out) and
   `PHASE1_ENTITY_LINK_CONCURRENCY` (lock-free LLM fan-out) tune the two phases
   independently. The entity-link pool can go higher (it's off the lock) — bound
   it by Groq rate limits, not the DB.
4. Per-segment fact extraction auto-skips at ≥30 segments
   (`skip_fact_extraction`); override per-upload with `metadata.force_fact_extraction`.
5. The remaining ~1s/segment in `promote` is the lock-held DB write + conflict
   detection (Qdrant similarity search + Postgres). Further wins would require
   batching conflict detection across segments — a future optimization, higher risk.

---

## 11. Known failure modes & fallbacks

| Symptom | Cause | Handling |
|---------|-------|----------|
| *"Ingestion timed out"* | hung Groq entity-link held per-user lock | fixed: `AbortSignal.timeout(25s)` + deferred linking |
| Docling 5xx / empty on PDF | sidecar down / unsupported | auto-fallback to fast-pdf Tier 1, then raw utf-8 |
| `G E M E I N` letter-spaced titles | designed-PDF tracking text layer | `collapseLetterSpacing()` |
| `unexpected end of hex escape` on insert | NUL/control bytes from PDF text layer | stripped in `collapseLetterSpacing()` |
| `167 segs → 13 promoted` looks like loss | diversity sampling (by design) + dedup | drop counter in `emit('promoted')` makes it explicit; full text still in evidence layer |
| entity tags missing right after upload | deferred linking is eventual | tags land seconds later via `linkEntitiesForMemories` |
| chunk not found by filename in recall | — | `filename:`/`doc-hash:`/`doc-id:` tags on every promoted memory make literal-filename recall hit every chunk |

---

## 12. Related docs

- `docs/MEMORY_COGNITION_LIFECYCLE.md` — what happens to promoted memories (drift compaction, canonical summaries).
- `docs/recall-scoring.md`, `docs/updated_recall.md` — how promoted memories are retrieved.
- `docs/three-tier-retrieval-api.md` — retrieval tiers.
- `~/.claude/skills/hivemind-apex/` — the canonical save pipeline + the eight recurring gotchas.
