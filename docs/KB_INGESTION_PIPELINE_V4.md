# Knowledge-Base Ingestion Pipeline — v4

> Status: **live** (verified end-to-end on production `df710f24`, 2026-07-17).
> This is the authoritative description of how a knowledge-base document becomes
> durable, recallable, graph-connected organizational memory. It reflects the
> code as deployed, not intent. v4 supersedes the earlier BulkQM + canonical-
> ingest write-ups by adding: deterministic destructive-edge gating, canonical-
> entity persistence that actually works, truncation-proof extraction, and
> Groq-via-OpenRouter model routing.

---

## 0. One-paragraph summary

A KB upload is accepted in ~100 ms (validate → checksum → dedup → persist bytes
→ enqueue) and made searchable within seconds by a durable worker pool. The
worker parses the document, chunks it, and runs a **single structured LLM
extraction per window** on **gpt-oss-120b via OpenRouter→Groq** that returns
facts + canonical entities + intra-window relationships together. Every fact is
stamped with uniform provenance, embedded, indexed (vector + lexical), linked to
its evidence, and — new in v4 — its canonical entities are persisted to the
`CanonicalEntity` / `MemoryEntityLink` registry. All destructive graph edges
(`Updates`/`Contradicts` and any `is_latest` demotion) pass a **deterministic
claim-signature validator** before they can hide a memory. Org type (Personal /
Managed / Self-host) changes only the storage seam, never the pipeline.

---

## 1. Request path (Tier-1, synchronous, no LLM)

```
POST /api/knowledge/upload  (multipart, one file/request)
  1. auth + plan-quota check
  2. sha256 checksum
  3. DUPLICATE GATE → 409 if same bytes already in this org (force=true overrides)
  4. persist raw bytes → kb-store/<org>/<checksum>/
  5. ENQUEUE BullMQ "kb-ingest" (jobId = <org>-<checksum>, idempotent)
  6. return 202 { job_id, status:'queued' }   (~0.1s)
```

Durability: raw bytes on disk + BullMQ job in Redis survive restarts; closing
the tab loses nothing. Rollout via `KB_QUEUE_MODE` (`off` | `all` | `<org,org>`);
no Redis → inline fallback. Status is mirrored to Redis (`kbq:status:<job_id>`,
24 h TTL) so any node answers the FE poll (no per-process 404s). Fairness: per-org
concurrency cap; backpressure: global + per-org depth caps → `429 Retry-After`.

---

## 2. Worker path (Tier-2, async, parallel)

`documentFirstIngestion.ingestKnowledgeDocument(rawBytes)`:

### 2.1 Parse → segment
- Docling (text fast-path; GPU OCR only if scanned) for PDF/DOCX/PPTX/XLSX/CSV;
  image-vision OCR; Whisper STT for audio.
- Boilerplate filter (regex, no LLM) → contextual semantic chunking →
  `knowledge_segments` rows (searchable immediately: vector + lexical + `PartOf`).

### 2.2 Unified extraction — the core LLM step
Entry: `_promoteMemories` → (default `KB_UNIFIED_EXTRACT=true`) →
`_ingestUnifiedWindow` → `_extractUnifiedReliable` → `_extractUnified`.

**One structured call per window** returns facts + each fact's canonical
entities + intra-window typed relationships together — coherent, entity-
consistent (aliases collapse inside the call), far fewer LLM calls.

- **Model**: `KB_UNIFIED_MODEL` (prod: `openai/gpt-oss-120b`) → routed by
  `litellm-client` to **OpenRouter with `provider.order=["Groq"]`** (Groq
  backend for speed, `allow_fallbacks:true` for resilience). ~2–4 s/window,
  `json_object` mode (Groq rejects strict `json_schema`).
- **max_tokens = 4500** (compact retry 2200). This is load-bearing: at the old
  1800 dense sections truncated (`finish=length`) and **every fact in that
  section was silently lost** (~28% of calls). At 4500, `finish=stop`.
- **Truncation-salvage backstop** (`litellm-client._salvageArrayObjects`): if a
  response is ever cut off, recover every COMPLETE fact object from the partial
  array (brace-counted, string/escape-aware) instead of discarding the section.
- **Retry** (`_extractUnifiedReliable`): sparse/failed extraction retries once
  compact; a provider `finish=error` (rare, ~0.3%) falls back via OpenRouter.

Measured (2026-07-17, real dense Solvis section): extraction failure ~0.3%
(was ~28%); gpt-oss-120b/20b via Groq ≈4 s, valid JSON, 8/8 facts-with-entities.
Model note: **do not** drop to llama-8b — 17× cheaper but returns fragments with
no entities (breaks the graph layer). gemini-2.5-flash-lite is a viable
alternative (more granular, ~4 s) but the current standard is gpt-oss-120b/Groq.

### 2.3 Fact persistence (per fact, via the canonical gateway)
`memoryGraphEngine.ingestMemory(...)` with `skip_fact_extraction`,
`defer_entity_linking`, `skip*` fast-path flags. Each fact memory carries:
- content + title + `memory_type` + LLM `importance`;
- provenance: `source_metadata{source_platform, source_type, source_id,
  source_url, document_id}`, `document_date`;
- uniform tags: `entity:<slug>` (per canonical entity), `ts:<date>`,
  `distilled-from-kb`, `extracted-fact`, `filename:<name>`, `doc-id:<id>`,
  `promoted-memory`;
- evidence link (`memory_evidence_links`) + derivation (`memory_derivations`).

Then one batched contextual embed (bge-m3) → vector + lexical index.

### 2.4 Canonical-entity registry (v4 — the previously-broken half)
After the window's facts commit, `persistCanonicalLinks` turns the extractor's
canonical NAMES into durable `CanonicalEntity` + `MemoryEntityLink` rows:
- exact-slug match within (org, kind) → **reuse** existing entity (across docs +
  surface/legal-suffix/case variants);
- genuinely new name → **create**;
- ambiguous fuzzy → **review queue** (never auto-merged);
- serial per unique name so concurrent windows can't race-create duplicates.

**Historical bug fixed in v4:** `canonical_entities` has a `NOT NULL
normalized_name` column that the Prisma model never mapped → every insert threw
`P2011` → the registry was 0 for every org, forever. v4 maps + populates
`normalizedName`. `entity:` tags remain the compatibility/fallback linkage.

Backfill for existing corpora (no re-upload): `scripts/backfill-canonical-entities.mjs --org <id> [--apply]`.

### 2.5 Relationship edges + the deterministic gate
Intra-window typed edges come from the same structured call. A separate
gray-zone pass (`kb_hybrid_v1`) proposes `Updates`/`Contradicts`/`Extends`/
`Mentions`; the recall-based co-mention pass adds cross-doc edges.

**Every destructive edge and every `is_latest` demotion** now passes
`validateSupersedingEdge` (`RELATIONSHIP_VALIDATOR_MODE=enforce`, default):
- **claim-signature** comparison (`claim-signature.js`): canonical subjects +
  typed value slots (numbers+units, years, dates, %, model-ids) — language-
  neutral, deterministic. An LLM may *propose* an edge; structure *decides* it.
- Rules: same specific subject required (beyond the corpus-dominant hub entity),
  no exclusive-subject conflict (SolvisPia ≠ SolvisLea), same-attribute value
  comparison. `Updates` additionally needs change-evidence (differing values);
  a paraphrase duplicate → `Extends` (corroboration), never supersession.
- On failure: edge downgraded to Extends/Mentions (reason kept in metadata),
  demotion withheld. Modes: `enforce` (act) | `shadow` (log only) | `off`.
- Measured false-positive rate of the old ungated algorithmic edges: **~73%**
  across tenants — this gate is why v4 recall doesn't hide real facts.

---

## 3. Recall (what ingestion feeds)

Multi-lane, fused, then narrowed: vector + Postgres FTS + entity-tag + **Hop-0
canonical-entity lane** + temporal + graph expansion + cross-lingual rescue →
weighted-max fusion → relevance floor → dedup → optional cross-encoder rerank →
top-K. Hop-0 (`entity-hop0.js`) is a bounded deterministic registry lookup
(≤8 tokens / 12 entities / 40 candidates, ~125 ms, fail-open) that surfaces
entity-linked memories as additive candidates — acronyms/short entity queries
resolve immediately; boosts relevance, never overrides it.

**Fixed in v4:** `searchMemories` FTS-fallback referenced an undefined
`upperCreatedAt` → any query hitting that path threw and killed the whole recall
call. Restored.

---

## 4. Residency (unchanged shape, one seam)

`runWithOrg(orgId) → memoryBackend(orgId)` is the only place org type branches:

| Org type | Backend | Storage |
| --- | --- | --- |
| Personal | central | shared Postgres + Qdrant |
| Managed | central per-tenant | `org_<id>` Postgres + Qdrant collection |
| Self-host (BYOD) | agent | customer box; central stores zero memory data |

**Open v4 gap:** `canonicalEntity` is not yet in the proxy `ROUTED_MODELS`, so
canonical-entity persistence is correct for central orgs only. Self-host parity
(route `canonicalEntity` to the agent) is required before v4 ships for BYOD.

---

## 5. Config knobs

| Knob | Default | Meaning |
| --- | --- | --- |
| `KB_QUEUE_MODE` | `all` | inline / queued / per-org canary |
| `KB_UNIFIED_EXTRACT` | `true` | unified single-call extractor |
| `KB_UNIFIED_MODEL` | `openai/gpt-oss-120b` | extraction model |
| `KB_UNIFIED_MIN_IMPORTANCE` | `0.65` | promotion floor |
| `LLM_PRIMARY` | `openrouter` | route all LLM calls via OpenRouter |
| `OPENROUTER_PROVIDER_ORDER` | `Groq` | preferred backend for Groq-served models |
| `OPENROUTER_ALLOW_FALLBACKS` | `true` | degrade to another provider vs fail |
| `RELATIONSHIP_VALIDATOR_MODE` | `enforce` | destructive-edge gate: enforce/shadow/off |
| `CANONICAL_ENTITY_PERSIST` | `on` | canonical registry persistence |
| `RECALL_ENTITY_HOP0` | `on` | Hop-0 entity recall lane |

---

## 6. Failure modes & guarantees

- **Extraction truncation** → salvage recovers complete facts; max_tokens sized
  to avoid it (measured ~0.3% residual, retried).
- **Provider outage** (Groq 429/down) → OpenRouter fallback (slower, not failed).
- **Bad LLM edge** → deterministic validator downgrades it; no real memory hidden.
- **Duplicate upload** → 409 upfront; idempotent job id.
- **Worker crash / restart** → durable bytes + BullMQ retry (attempts:3, DLQ).
- **Recall lane failure** → each lane is additive/fail-open; Hop-0 fails to `[]`.

## 7. What still needs work for "every deploy, every tenant"

1. **Regression eval harness** — prove extraction yield + recall quality +
   edge precision on each deploy (currently verified manually per-upload).
2. **Self-host `ROUTED_MODELS` parity** for `canonicalEntity`.
3. **Keep-side edge precision** — the validator's false-negative rate (genuine
   updates wrongly downgraded) is not yet measured, only the false-positive win.

---
*v4 — one document, one schema, one pipeline; deterministic where it matters;
org type only at the storage seam.*
