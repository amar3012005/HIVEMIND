# HIVEMIND API Reference

Complete reference for the HIVEMIND engine API, control plane, MCP tools, and the `.amr` agent
protocol.

**Every payload and response in this document was verified against the live deployment**
(`hivemind/core-api:sha-70c665565`, 2026-08-04) unless explicitly marked *unverified*. Field lists
come from real responses, not from reading the handler.

---

## Contents

1. [Base URLs & ports](#1-base-urls--ports)
2. [Authentication](#2-authentication) ← **read this first, it is the #1 source of wasted time**
3. [Errors](#3-errors)
4. [Chat](#4-chat)
5. [Recall & search](#5-recall--search)
6. [Memories CRUD](#6-memories-crud)
7. [Knowledge base / upload](#7-knowledge-base--upload)
8. [Evidence (verbatim segments)](#8-evidence-verbatim-segments)
9. [Entities & graph](#9-entities--graph)
10. [Ingestion (non-upload sources)](#10-ingestion-non-upload-sources)
11. [Cognition / governance](#11-cognition--governance)
12. [Billing & usage](#12-billing--usage)
13. [Admin](#13-admin)
14. [MCP tools](#14-mcp-tools)
15. [`.amr` agent protocol](#15-amr-agent-protocol)
16. [Storage modes](#16-storage-modes)
17. [Environment reference](#17-environment-reference)

---

## 1. Base URLs & ports

| surface | internal | public | purpose |
|---|---|---|---|
| **Core engine** | `http://localhost:2026` → container `:3000` | `https://core.singulancelabs.com` | Memories, recall, chat, KB, graph. **Takes a scoped API key.** |
| **Control plane** | `http://localhost:2027` → container `:3000` | `https://api.singulancelabs.com` | Auth, orgs, billing, connectors, `/v1/proxy/*` for the browser. **Takes a session Bearer.** |
| **Frontend** | `http://localhost:2388` | `https://next.singulancelabs.com` | Dashboard. |
| **`.amr` agent** (BYOD) | `http://hm-byod-agent:8787` | — | Per-org memory shard. Agent token. |

`/v1/proxy/*` on the control plane forwards to core with the caller's org identity resolved
server-side. **The browser must use the proxy**, never core directly — see §2.

---

## 2. Authentication

> This is the single most common cause of "the API returns an empty result but nothing is
> broken". Getting it wrong produces a **convincing 200 with no rows**, not a 401.

### Core engine `:2026` — scoped API key

```http
Authorization: Bearer hmk_live_<...>
```

The key resolves org **and** user server-side. Keys are stored **hashed**; only `key_prefix`
(e.g. `hmk_live_dcb`) is readable from the database, so **a key cannot be recovered or minted from
the DB** — it must be created through the control plane.

### Control plane `:2027` — session Bearer

```http
Authorization: Bearer <session-jwt>
```

### `X-Org-Id` is **CORS, not auth**

```
X-Org-Id: <uuid>     # ← does NOT change which tenant you read
```
Headers cannot impersonate an org. A request with someone else's `X-Org-Id` returns *your* data,
silently. This has repeatedly produced fabricated "recall bugs".

### `.amr` agent `:8787`

```http
Authorization: Bearer <AGENT_TOKEN>
```
Every route returns `401 {"error":"unauthorized"}` without it.

---

## 3. Errors

| status | meaning | notes |
|---|---|---|
| `400` | Validation failure | Body names the offending field. |
| `401` | Missing/invalid credential | |
| `403` | Authenticated but wrong org, or role required | e.g. `org_scope_admin_only`, `PRIVILEGED_AGENT_ROLE_REQUIRED` |
| `402` | Plan limit exceeded | **Verified live.** See below. |
| `404` | Not found, or not visible in your scope | Indistinguishable by design. |
| `409` | Duplicate | Upload dedup returns the existing `job_id`. |
| `501` | Not supported for this storage mode | **Deliberate.** See below. |

### `402` — plan limit (verified live)

```json
{
  "error": "plan_limit_exceeded",
  "code": "plan_limit_exceeded",
  "message": "Monthly upload limit exceeded (Free plan: 10 uploads/month)",
  "resource": "uploads",
  "plan": "free",
  "limit": 10,
  "current": 11,
  "suggested_plan": "pro",
  "upgrade_url": "/hivemind/app/billing"
}
```

### `501` — storage-mode refusal (verified live)

```json
{
  "storage_mode": "amr",
  "supported": false,
  "error": "not_supported_for_amr_storage",
  "endpoint": "/api/admin/contradictions",
  "message": "This endpoint reads the central graph. This org stores its memories on its .amr agent, so no numbers are reported rather than misleading zeros."
}
```

This is **correct behaviour, not a bug**: the endpoint declines rather than returning a
misleading `0`. Clients should gate such calls on `storage_mode` from
`GET /api/memory/stats` rather than calling and catching.

---

## 4. Chat

### `POST /api/chat`

The full agent turn: intent → retrieval → grounded answer.

**Request**
```json
{
  "message": "What did we decide about pricing?",
  "model": null,
  "history": [{ "role": "user", "content": "..." }, { "role": "assistant", "content": "..." }],
  "stream": false,
  "language": null,
  "scope": "all",
  "project_id": null,
  "project_ids": [],
  "limit": null
}
```

| field | type | default | notes |
|---|---|---|---|
| `message` | string | **required** | A leading `[STRICT LANGUAGE: xx]` marker is stripped before use. |
| `model` | string\|null | caller-selected answer model | |
| `history` | array | `[]` | Prior turns. |
| `stream` | bool | `false` | SSE when true. |
| `language` | string\|null | auto | |
| `scope` | enum | `all` | `personal` \| `project` \| `team` \| `organization` \| `all`. **Narrows only — never widens.** |
| `project_id` | uuid\|null | — | `project_ids[0]` accepted as an alias. |

**Response (non-stream)**
```json
{
  "response": "…",
  "sources": [ { "id": "A1", "source_type": "memory|evidence_segment|entity_aggregate", "title": "…", "snippet": "…" } ],
  "steps": [ { "tool": "hivemind_recall", "args": {}, "result_summary": "5 memories + 8 evidence" } ],
  "scopes_found": ["personal", "project:SOLVIS"],
  "answer_mode": "sampled",
  "answer_basis": { "mode": "sampled", "exhaustive": false, "sampled_sources": 7, "tools_used": ["hivemind_recall"] },
  "evidence_used": [],
  "confidence": 0.9,
  "gaps": [],
  "usage": {},
  "trace": {},
  "assistant_name": null,
  "project_choice": null
}
```

**`answer_mode`** — how the answer was obtained, derived from the steps **actually executed**:
- `counted` — a real aggregate ran (`hivemind_count_where` / `hivemind_aggregate_entities`); numbers are exhaustive.
- `temporal` — `hivemind_timeline` / `at` / `diff`.
- `graph` — `hivemind_traverse_graph` / `relation_between`.
- `sampled` — top-K similarity. **Any number in the prose is indicative, not exhaustive.**

**`scopes_found`** — distinct tiers the answer drew from, across **both** the memory and evidence
lanes. Empty on connector-write turns that retrieve nothing.

**Timeout semantics.** If retrieval exceeds `HIVEMIND_AGENT_RETRIEVAL_BUDGET_MS` (default
**12 000 ms**), `coverage.retrieval_timed_out` is set and the reply says the lookup was cut off and
to retry. It will **never** claim the topic is absent — a timeout is not an absence.

---

## 5. Recall & search

### `POST /api/recall`

**Request**
```json
{
  "query": "Wartungsvertrag",
  "limit": 10,
  "mode": "quick",
  "entities": ["Nordwind Energie GmbH"],
  "answer_type": null,
  "scope": null,
  "project_id": null,
  "valid_at": null,
  "known_at": null,
  "source_platforms": []
}
```

| field | notes |
|---|---|
| `query` | **required.** |
| `mode` | `quick` \| `deep` \| `insight`. |
| `entities` | Anchors the entity-hop lane. |
| `answer_type` | Enables the type-scoped lane (`V5_TYPE_AWARE_RECALL`). Nullable enum — must be *declared*, or `validateAndSanitize` strips it. |
| `valid_at` / `known_at` | Bi-temporal snapshot. |

**Response — verified live, exact top-level keys**
```json
{
  "memories": [],
  "synthesized": null,
  "raw": [],
  "search_method": "...",
  "spine": {},
  "project_scope_applied": false,
  "mode_used": "quick",
  "evidence": [],
  "evidence_count": 0,
  "live": [],
  "live_count": 0,
  "recall_trace": {},
  "timing_ms": 0
}
```

### Other search routes

| endpoint | purpose |
|---|---|
| `GET /api/memories/search?q=` | Lexical/vector memory search. |
| `POST /api/memories/query` | Structured filter query. |
| `POST /api/search/quick` | Low-latency single lane. |
| `POST /api/search/insight` | Synthesis-oriented. |
| `POST /api/search/panorama` | Broad multi-lane sweep. |
| `POST /api/search/compare` | Unified recall through one engine (A/B harness). |
| `POST /api/search/pageindex` | PageIndex tree search. |
| `POST /api/memories/traverse` | Graph walk from seeds. |

---

## 6. Memories CRUD

### `GET /api/memories`

`?limit=` `&offset=` `&scope=` `&project_id=` `&memory_type=` `&tags=` `&is_latest=`

**Response — verified live**
```json
{
  "memories": [ { "...": "see fields below" } ],
  "pagination": { "total": 101, "offset": 0, "limit": 20, "has_more": true }
}
```

**Memory object — exact field list from a live response:**

```
id, user_id, org_id, owner, owner_name, title, content, memory_type,
scope, project, project_id, project_ids, primary_team_id,
tags, metadata, source_metadata,
importance_score, strength, recall_count, last_accessed_at,
is_latest, layer, cognitive_layer_role,
edges_in_count, edges_out_count,
valid_from, valid_to, document_date, created_at, updated_at
```

`scope` ∈ `personal | project | team | organization`. Always present — both the central
(`mapMemoryRecord`) and agent (`mapAgentRow`) mappers stamp it.

### Other memory routes

| method | endpoint | notes |
|---|---|---|
| `POST` | `/api/memories` | Create. Canonical route (V5 Phase 5B). |
| `GET` | `/api/memories/:id` | |
| `PATCH` | `/api/memories/:id` | |
| `DELETE` | `/api/memories/:id` | `?hard=true` for GDPR erasure (purges Postgres **and** vectors). |
| `POST` | `/api/memories/reinforce` | Bump recall strength. |
| `POST` | `/api/memories/decay` | Run decay. |
| `POST` | `/api/memories/bulk-delete-by-tag` | **Sweeps Qdrant too.** Clearing Postgres alone leaves orphan vectors that silently break recall. |
| `POST` | `/api/memories/delete-all` | Destructive. |
| `POST` | `/api/memories/code/ingest` | Code-aware ingestion. |
| `GET` | `/api/memories/ingest/status` | |

### `GET /api/memory/stats` — verified live

```json
{ "memories": 101, "relations": 359, "scope": "all", "storage_mode": "amr", "noise_filtered": false }
```

**`storage_mode`** is the field clients should branch on: `hybrid` \| `amr` \| `byod`. Use it to
skip central-graph-only features rather than calling them and handling `501`.

---

## 7. Knowledge base / upload

### `GET /api/knowledge/upload-capabilities` — verified live, full response

```json
{
  "version": 1,
  "endpoint": "/api/knowledge/upload",
  "asynchronous": true,
  "scopes": ["personal", "project", "team", "organization"],
  "kinds": {
    "document": { "minBytes": 32, "maxBytes": 52428800,
      "extensions": ["pdf","docx","doc","xlsx","xls","pptx","ppt","txt","md","markdown","csv","tsv","html","htm"] },
    "image":    { "minBytes": 1,  "maxBytes": 20971520,
      "extensions": ["png","jpg","jpeg","tiff","tif","webp","gif"] },
    "audio":    { "minBytes": 1,  "maxBytes": 52428800, "extensions": ["…5 types"] }
  }
}
```

**Query this instead of hardcoding limits.** Document max is **50 MB**, image **20 MB**.

### `POST /api/knowledge/upload`

`multipart/form-data`, `?async=true` strongly recommended.

| part | notes |
|---|---|
| `file` | **required.** |
| `targetScope` | `personal` \| `project` \| `team` \| `organization`. Org scope requires owner/admin (`403 org_scope_admin_only`). |
| `projectId` | Required when `targetScope=project`. |
| `primaryTeamId` | For team scope. |
| `tags` | Extra tags. |
| `force` | Bypass dedup. |

**Response `202` (async) — verified live**
```json
{
  "job_id": "24d57165-73e1-4dce-a96f-195e98641988",
  "status": "queued",
  "stage": "queued",
  "progress": 0,
  "document_id": null,
  "memory_ids": [],
  "storage_mode": "amr_embedded",
  "counts": { "pages": null, "segments": null, "candidates": null, "memories": null },
  "error": null,
  "created_at": "2026-08-04T14:02:26.383Z",
  "updated_at": "…"
}
```

> **Client design note.** The POST returns as soon as the bytes are in — measured **80 ms**.
> Server-side ingest then runs for **12 s to 2 min** depending on document size. Do **not** hold a
> client upload slot waiting for completion: the server has its own queue (cap 6), and a second
> client-side gate on *processing* only hides progress. Release the slot on `job_id` and poll.

### `GET /api/knowledge/status?job_id=` — verified live

```json
{
  "job_id": "24d57165-…",
  "status": "ready",
  "stage": "ready",
  "progress": 100,
  "document_id": "132284fa-…",
  "memory_ids": ["5920ea04-…", "…"],
  "metadata": { "stage": "…", "segmentCount": 16, "promotedCount": 14, "candidateCount": 21 }
}
```

**`status`**: `queued` → `parsing` → `parsed` → `segmenting` → `segmented` → `embedding` →
`embedded` → `promoting` → `promoted` → `ready` \| `failed` (also `indexed` as a terminal alias).

Doc fields may arrive **nested under `metadata`** (in-memory tracker) *or* **flat at top level**
(durable Redis mirror). **Read both** — this has caused a queued upload to resolve a null
`documentId`.

### `POST /api/knowledge/upload/precheck`

Requires `checksum` (hex sha256 of the bytes) — verified: omitting it returns
`{"error":"checksum must be a hex sha256 of the file bytes"}`. Used for dedup before spending
bandwidth.

### Other KB routes

| method | endpoint | notes |
|---|---|---|
| `POST` | `/api/knowledge/upload-bulk` | Multiple files. |
| `GET` | `/api/knowledge/document?id=` | Document + segments. |
| `POST` | `/api/knowledge/relations-summary` | **POST only** — a GET returns an empty body. |
| `GET` | `/api/knowledge/queue-stats` | BullMQ depth. |

### Ingestion pipeline (what happens after `202`)

```
bytes → normalize.js seam (docx/html/md/txt → markdown-or-NULL, binary FAILS)
      → tier chain (sheet-direct | csv-direct | fast-pdf | groq-vision | docling | whisper)
      → segments (heading, heading_path, pages, segment_type)
      → embeddings (bge-m3, 1024-dim)
      → windows → unified extract (facts + entities in ONE call per section batch)
      → curator (dedup/merge) → memories
      → canonical entities (typed) + relationship edges
      → claim structuring (ONE batched call, post-commit)
```

Every memory is stamped `«filename : heading» … (recorded YYYY-MM-DD)` and tagged
`source:kb`, `filename:*`, `ts:*`, `document-type:*`.

---

## 8. Evidence (verbatim segments)

Evidence is the **lossless** lane: verbatim `knowledge_segments`, as opposed to LLM-derived
memories. Small details (part numbers, prices, spec values) live here.

| method | endpoint | notes |
|---|---|---|
| `POST` | `/api/evidence/search` | Segment search. |
| `POST` | `/api/evidence/hybrid` | Memories + evidence, one ranked delivery. |
| `GET` | `/api/evidence/document?id=` | Segments for a document. |
| `GET` | `/api/evidence/memory?id=` | Segments backing a memory. |

**Evidence row shape** (from `fmt()` in `evidence-retrieval.js`):
```json
{
  "type": "evidence_segment",
  "segmentId": "…", "documentId": "…",
  "content": "…", "snippet": "…", "score": 0.83,
  "scope": "personal", "project_id": null,
  "document": { "id": "…", "title": "…", "documentType": "…", "sourcePlatform": "…", "sourceUrl": "…", "documentDate": "…" },
  "metadata": { "segmentType": "paragraph", "segmentIndex": 4, "wordCount": 120,
                "startPage": 3, "endPage": 3, "heading": "Preise",
                "heading_path": "Kapitel 1 > Preise", "depth": 2 }
}
```

`scope` is derived from the document's `scope-key:*` tag (segments carry no scope column).
`document.tags` is deliberately **stripped** from the payload. Untagged documents ⇒ `personal`,
because untagged documents *are* owner-only.

---

## 9. Entities & graph

| method | endpoint | notes |
|---|---|---|
| `GET` | `/api/entities?limit=` | Canonical entities. **Returns `[]` for `.amr` orgs** — the registry is central. |
| `GET` | `/api/entities/stats` | |
| `GET` | `/api/entities/review-queue` | Ambiguous fuzzy matches awaiting a decision. |
| `GET` | `/api/entities/by-external-ref?ref=` | |
| `POST` | `/api/admin/entities/merge` | Merge duplicates. |
| `GET` | `/api/graph` | Nodes + edges. |
| `POST` | `/api/graph/intelligent` | Query-shaped subgraph. |
| `GET` | `/api/graph/quality` | |
| `POST` | `/api/graph/hygiene/scan` \| `/execute` | Find/fix edgeless nodes. |
| `GET` | `/api/relationships` | Typed edges. |

**Entity kinds:** `person`, `organization`, `product`, `place`, `technology`, `standard`,
`concept`, and legacy `entity`. Identity is keyed by **(kind, normalized slug)** — the same
surface form under two kinds is two identities. Unrecognised kinds fall back rather than
fragmenting the registry.

**Edge types include:** `Derives`, `PartOf`, `Updates`, `Supersedes`, `RelatesTo`.

---

## 10. Ingestion (non-upload sources)

| method | endpoint | mode | notes |
|---|---|---|---|
| `POST` | `/api/ingest` | `atomic` | One memory through the engine gateway. |
| `POST` | `/api/ingest/source` | envelope | Canonical envelope; caller picks `mode`. |
| `POST` | `/api/ingest/image` | `document`→atomic | Groq vision; produces **one** canonical `fact` memory. |
| `POST` | `/api/ingest/chat-session` | `atomic` | Conversation capture. |
| `GET` | `/api/ingest/status` | | |
| `POST` | `/api/connectors/mcp/ingest` | `document` | Connector documents. |
| `POST` | `/api/meetings/:id/ingest` | typed tree | Parent `event` memory + one `PartOf` child per section; transcript stored as recall-excluded `evidence`. |

**Envelope modes** (see `ingestion_v5.md`):
- `document` — long/multi-fact → distill → many fact memories + entities + relationships.
- `atomic` — one memory, routed through the smart router unless `smartIngest:false`.
- `evidence` — one recall-excluded, non-distilled raw memory.

All paths funnel through `createMemory`, which stamps `claim_key` / `claim_subject` / timestamps.

---

## 11. Cognition / governance

| method | endpoint | notes |
|---|---|---|
| `GET` | `/api/cognition/status` | |
| `GET` | `/api/cognition/runs` | |
| `GET` | `/api/cognition/recent` | |
| `POST` | `/api/cognition/synthesize-now` | Force a cycle. |
| `POST` | `/api/cognition/run-dreams` | |
| `POST` | `/api/cognition/stop` | |
| `GET` | `/api/cognition/derivation?id=` | Why a synthesis exists. |
| `GET`/`POST` | `/api/cognition/retention` | |

**Shared token pool.** Governance runs against a daily pool
(`PHASE_E_POOL_DAILY_BUDGET`, currently **3 000 000**). When exhausted, every cycle logs
`[gov-cycle] shared token pool exhausted (spent=N/N)` and does nothing until the next day. This is
a **budget, not a bug** — but consolidation is genuinely off while it lasts.

---

## 12. Billing & usage

| method | endpoint | notes |
|---|---|---|
| `GET` | `/api/billing/plans` | Catalog. |
| `GET` | `/api/billing/usage` | Current period. |
| `GET` | `/api/billing/usage/daily` | |
| `POST` | `/api/billing/upgrade` | |
| `POST` | `/api/billing/plan/refresh` | |

**Metrics tracked** (`hivemind.usage_events.metric`): `knowledge_uploads`,
`knowledge_base_pages`, `memories_ingested`, `search_queries`, `graph_queries`, `tara_calls`.

Limits are enforced **on the consuming path** — verified: an 11th upload on a Free plan returns
`402` (§3), it is not merely defined in a catalog.

---

## 13. Admin

Require owner/admin. Several return `501` for `.amr` orgs (central-graph reads).

| endpoint | notes |
|---|---|
| `GET /api/admin/contradictions` | **`501` on `.amr`.** |
| `GET /api/admin/memory-metrics` | |
| `GET /api/admin/topic-states` | |
| `POST /api/admin/backfill` | |
| `POST /api/admin/relink-edgeless` | |
| `POST /api/admin/entities/merge` | |
| `GET /api/admin/org/policy` | |
| `GET /api/admin/webhook-events/dead-letter` | |
| `GET /api/admin/webhook-subscriptions/health` | |
| `GET /api/audit/logs` | Retention `AUDIT_RETENTION_DAYS=2555`. |

---

## 14. MCP tools

Endpoint: `POST /api/mcp/rpc` (JSON-RPC). Transports: SSE and Streamable HTTP.

**Recall & read**
| tool | key args |
|---|---|
| `hivemind_recall` | `query`, `mode`, `limit`, `entities`, `answer_type`, `valid_at`, `known_at` |
| `hivemind_get_memory` | `memory_id` |
| `hivemind_list_memories` | `limit`, `offset`, filters |
| `hivemind_count_where` | filter → **exhaustive** count (sets `answer_mode: counted`) |
| `hivemind_aggregate_entities` | `kind`, `parent` |
| `hivemind_query_table` | structured table query |
| `hivemind_query_with_ai` | natural-language over structured data |
| `hivemind_recall_bugs` | prior-defect recall |

**Write**
| tool | key args |
|---|---|
| `hivemind_save_memory` | `title`, `content`, `tags[]`, `project_id?` |
| `hivemind_update_memory` | `memory_id`, patch |
| `hivemind_delete_memory` | `memory_id`, `hard?` |
| `hivemind_log_decision` | decision record |
| `hivemind_set_assistant_name` | `name` |

**Graph & temporal**
| tool | key args |
|---|---|
| `hivemind_traverse_graph` | `memory_id`, `depth`, `relationship` |
| `hivemind_relation_between` | `a`, `b` |
| `hivemind_timeline` | entity/topic over time |
| `hivemind_at` | as-of snapshot |
| `hivemind_diff` | change between two points |

**Code & web**
| tool | key args |
|---|---|
| `hivemind_why_code`, `hivemind_code_at` | code provenance |
| `hivemind_web_search`, `hivemind_web_crawl`, `hivemind_web_job_status` | web intel |

**Profile:** `get_user_profile` (caller-scoped), `update_user_profile`.

**Projects:** `hivemind_list_projects`, `hivemind_create_project`.

> **Schema gotcha.** `validateAndSanitize` **strips undeclared keys**. A new argument must be
> declared in the tool schema or it silently vanishes — this is what initially broke
> `answer_type`.

---

## 15. `.amr` agent protocol

35 endpoints, all `POST` with a JSON body, all requiring `Authorization: Bearer <AGENT_TOKEN>`.
Implemented **twice** — `byod/agent/server.mjs` (standalone) and
`core/src/vector/mneme/embedded-agent.mjs` (in-process). **Both or neither**; parity is enforced
by `scripts/check-byod-sync.sh` and `core/tests/fixtures/byod-http-parity.mjs`.

**Memory**
```
/v1/write        /v1/recall       /v1/lexical      /v1/hydrate
/v1/list         /v1/update       /v1/update-tags  /v1/delete
/v1/purge        /v1/stats        /v1/bump-recall  /v1/clear-memories
```

**Graph**
```
/v1/edge         /v1/graph        /v1/mem-edges    /v1/mem-relationships
```

**Knowledge base**
```
/v1/kb-doc       /v1/kb-docs      /v1/kb-doc-detail  /v1/kb-doc-delete
/v1/kb-segment   /v1/kb-recall    /v1/kb-lexical     /v1/kb-hydrate
/v1/kb-tables    /v1/kb-provenance /v1/memory-evidence
```

**Meetings**
```
/v1/meeting-write  /v1/meeting-get   /v1/meeting-list  /v1/meeting-patch
/v1/meeting-delete /v1/meeting-segment-write /v1/meeting-segment-list
```

**TARA**: `/v1/tara-call`

**Example — `/v1/stats`** (verified live against `hm-byod-agent`):
```bash
curl -X POST http://hm-byod-agent:8787/v1/stats \
  -H "Authorization: Bearer $AGENT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"filter":{}}'
# → {"memories":17,"relationships":26}
```

**`/v1/recall`** takes a **pre-computed vector**, not text:
```json
{ "vector": [0.01, …1024 floats], "limit": 10, "filter": { "is_latest": true } }
```

**`/v1/lexical`** takes text and runs Postgres FTS over the SQL mirror — *not* the shard's own
index. This is deliberate: it makes both `.amr` modes rank text identically to `hybrid` and adds
filters the shard cannot express (`layer`, `must_not.layer`, `known_at`, `valid_at`).

**There is no `/v1/health`.** Probe with `/v1/stats`.

---

## 16. Storage modes

`organizations.memory_storage_mode` decides where a tenant's memories live. **Ingestion always
runs in core**, so the pipeline is identical; only the destination differs.

| mode | orgs | memories | KB segments | notes |
|---|---|---|---|---|
| `hybrid` | 6 | central `hivemind` schema + Qdrant | `hivemind.knowledge_segments` | Full feature set. |
| `amr_embedded` | 7 | `.amr` shard file + SQL mirror in `hm` schema | `hm.knowledge_segments` | In-process agent (`a.url === 'local:'`). |
| `byod_amr` | 1 | external agent `:8787` | agent-side | Single-tenant per container. |

**Client rule:** read `storage_mode` from `GET /api/memory/stats` and skip central-graph features
(`/api/admin/contradictions`, `/api/entities`) for non-`hybrid` orgs rather than calling and
handling `501`.

**`.amr` engine capability.** The shard is self-contained — its own vector index, `lexical()`,
`hydrate()`, `graph()`, `stats()`, no SQL required. This deployment nonetheless routes lexical
through Postgres for ranking parity and temporal filters (above). Shard files live at
`/app/data/mneme/<orgId>/` (`shard.amr`, `shard.edg`, `shard.lock`) on the persisted
`hivemind-data` volume — **this is the sole copy for an `.amr` org; back it up.**

---

## 17. Environment reference

Only variables that change API behaviour. **`.env` overrides every code default** — read
`docker exec hm-core env` before reasoning about any of these.

### Models
```
KB_UNIFIED_MODEL=google/gemini-2.5-flash-lite            # fact extraction (fast; 4.3s)
MEMORY_PROCESSOR_MODEL=deepseek/deepseek-v4-flash-0731   # small JSON calls
ENTERPRISE_EXTRACTION_MODEL=deepseek/deepseek-v4-flash-0731
KB_UNIFIED_FALLBACK_MODELS=deepseek/deepseek-v4-flash-0731,openai/gpt-oss-120b
COGNITION_WRITER_MODEL=openai/gpt-oss-120b
```
Fallbacks must be **different families** — two variants of one model inherit the same weakness.

### Embeddings
```
EMBEDDING_PROVIDER=litellm
EMBEDDING_FALLBACK_PROVIDER=openrouter      # baai/bge-m3
EMBEDDING_FALLBACK2_PROVIDER=               # optional third link
EMBEDDING_TERMINAL_FALLBACK=                # 'false' disables the guaranteed bge-m3 last resort
EMBEDDING_DIMENSION=1024
EMBEDDING_TIMEOUT_MS=30000
EMBEDDING_LINK_COOLDOWN_MS=60000
```
**Same dimension ≠ same vector space.** Only chain links running the *same model*; mixing spaces
returns nonsense neighbours with no error.

### Retrieval / rerank
```
HIVEMIND_AGENT_RETRIEVAL_BUDGET_MS=12000    # raised from 3000 (below measured cold recall)
HIVEMIND_AGENT_TURN_BUDGET_MS=60000
AGENT_TOOL_RESULT_MAX_CHARS=24000
RERANK_ENABLED=true
RERANK_MODEL=voyageai/rerank-2.5-lite
RERANK_PROVIDER=cohere
RERANK_POOL=150
V5_TYPE_AWARE_RECALL=true
CHAT_ROUTER=progressive
```

### Ingestion
```
KB_UNIFIED_EXTRACT=true
KB_UNIFIED_WINDOW_CHARS=2500
KB_MIN_FACTS_PER_WINDOW=3       # floor so no window goes unread
KB_SEAM_FORMATS=docx,html,htm,md,markdown,txt,text
KB_ATOMIC_FACTS=true
KB_MEMORY_CONTEXT_PREFIX=true   # «filename : heading» prefix
KB_LANG_DRIFT_THRESHOLD=0.45    # LANGUAGE DRIFT counter
KB_BINARY_RATIO_THRESHOLD=0.02
DOCLING_URL=http://docling:5001
GROQ_VISION_MAX_PAGES=200
GROQ_VISION_DENSITY=150
```

### Storage / governance
```
MNEME_ORGS=                      # "" none | "<orgId>" | "a,b" | "*" all
MNEME_DATA_ROOT=/app/data/mneme
MNEME_EMBEDDED_MAX_OPEN=64
PHASE_E_POOL_DAILY_BUDGET=3000000
ENTITY_REGISTRY_MAX=20000
```

---

## Appendix — client checklist

1. `GET /api/memory/stats` → branch on `storage_mode`; skip central-graph features when not `hybrid`.
2. `GET /api/knowledge/upload-capabilities` → never hardcode size/extension limits.
3. Upload with `?async=true`; **release your slot on `job_id`**, then poll `/api/knowledge/status`.
4. Read status fields from **both** `metadata.*` and the top level.
5. Handle `402` with the returned `upgrade_url`; handle `409` by reusing the returned `job_id`.
6. Treat `501` as "feature unavailable for this tenant", not an error to retry.
7. Never send `X-Org-Id` expecting it to select a tenant — it is CORS only.
8. On chat, check `answer_mode`: a number under `sampled` is indicative, not exhaustive.
9. If `coverage.retrieval_timed_out` is set, the answer is "I couldn't look", not "nothing exists".

---

*Session records: `kb_ingestion_2026-08-04.md`, `recall_2026-08-04.md`, `chat_2026-08-04.md`.
Architecture: `ingestion_v5.md`, `recall_final.md`.*
