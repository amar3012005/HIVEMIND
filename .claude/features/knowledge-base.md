# Knowledge Base

**Group:** Your Brain · **Route:** `/hivemind/app/knowledge`
**Status:** PARTIALLY HARDENED — 3 defects fixed and verified live, 1 open constraint

## Frontend
- `pages/KnowledgeBase.jsx`

## Backend endpoints called (8)
- `/v1/projects`
- `/v1/proxy/documents`
- `/v1/proxy/enterprise/upload/detect`
- `/api/knowledge/upload` (core, multipart — the ingest entrypoint)

## Backend implementation
- **Service:** core (`:2026`). Control-plane proxies via `/v1/proxy/*`.
- **Handler:** `core/src/knowledge/document-first-ingestion.js`
  → `DocumentFirstIngestionService.ingestKnowledgeDocument`
- **Pipeline:** upload → source artifact → Docling parse → **retain parsed text** →
  `knowledge_documents` row → segmentation (`knowledge_segments`) → unified
  extraction per window (`_extractUnified`) → curation (`_curateDocumentClaims`)
  → memories + `memory_evidence_links` → Qdrant vectors (per-org collection).
- **Async:** upload returns **HTTP 202**. Asserting immediately reads a
  half-written state.
- **Storage:** `source_artifacts`, `knowledge_documents`, `knowledge_segments`,
  `memories`, `memory_evidence_links`, Qdrant `org_<id>`.

### Density knobs (all env-tunable)
| knob | default | effect |
|---|---|---|
| `KB_UNIFIED_WINDOW_CHARS` | 1500 | window size for extraction |
| `KB_FACTS_PER_1K_CHARS` | 12 | facts allowed per 1k chars |
| `KB_UNIFIED_WINDOW_MAX_FACTS` | 10 | hard ceiling per window |
| `KB_UNIFIED_DOC_CAP` | 30 | total facts per document |
| `KB_UNIFIED_MIN_IMPORTANCE` | 0.65 | drop below this (**verified NOT a limiter**) |
| `KB_RETAIN_TEXT_MAX_CHARS` | 4000000 | retained source text bound |

## Production guardrails
- [x] **Tenant isolation** — memories/documents/segments carry `org_id`; Qdrant
      routes to `org_<id>` via `resolveCollectionForOrg` (traced live, correct).
- [x] **Reproducibility** — `artifacts/memory-ingest-canary.py`, 6/6 invariants.
- [x] **Failure mode (recall)** — an unread query used to return 200 + zero
      results; now aliased and warned (`3263ff1ea`).
- [x] **Re-processability** — parsed source text retained (`295594e54`), so an
      extractor improvement can be reapplied. Was previously impossible.
- [ ] **AuthZ** — not yet tested with a wrong-org caller.
- [ ] **Input validation** — behaviour on corrupt/huge/encrypted files untested.
- [ ] **Idempotency** — dedups on `sha256(content)` (a re-upload 409s), but the
      partial-failure path is untested: a crash mid-pipeline leaves a document
      and segment with no memories (observed while probing).
- [ ] **Observability** — a silently thin extraction is invisible without SQL.

## Reproduction
```bash
# mint a scoped key (headers cannot impersonate an org; the master key resolves
# to DEFAULT_ORG, not your tenant)
SID=<live cp:session:* from redis>
K=$(curl -s -X POST http://127.0.0.1:2027/v1/api-keys -H "Authorization: Bearer $SID" \
     -H 'Content-Type: application/json' -d '{"name":"audit"}' \
   | python3 -c 'import json,sys;print(json.load(sys.stdin)["api_key"])')

HM_API_KEY=$K python3 artifacts/memory-ingest-canary.py         # 6/6 expected
HM_API_KEY=$K python3 artifacts/memory-ingest-canary.py --keep  # inspect artifacts
```

## Fixed (verified live)
1. **Source text was destroyed at ingest** — `295594e54`. Step 1 claimed to
   "Store raw source artifact" but wrote only `{filename, uploadedAt}` plus a
   **computed** `storageLocation` pointing at nothing. No bytes, no text. Every
   extractor improvement therefore applied to new uploads only; the existing
   corpus was frozen at ingest-day quality (44 docs @ ~2.7 claims, unrecoverable).
   It also made `processing_version` meaningless — written `=1`, never read.
2. **Recall dropped the query** — `3263ff1ea`. `/api/recall` read only
   `query_context`/`context`; `{"query": …}` produced an empty query → no
   embedding → `persisted-keyword` → zero hits, shaped exactly like a broken
   engine.
3. **Extraction ceiling** — `c0395c940`. `min(4, …)` capped every window at 4
   facts regardless of content (~2.7/1k chars). Now `KB_UNIFIED_WINDOW_MAX_FACTS`
   (10) with the rate at 12/1k. Revenue fact now captured where it was dropped.

## Open constraint — extraction yield
Benchmarked against **cognee 1.4.0**, identical 97-word German fixture, same LLM
(gpt-oss-120b):

| | cognee | HIVEMIND |
|---|---|---|
| ingest | 153s | ~4s |
| captured | 17 entities / 51 edges | 3 claims |
| recall | 6.6–28.2s | 0.26–0.82s (`/chat` 1.7–2.1s incl. LLM) |
| accuracy on 3 queries | 3/3 | 1/3 |

**The two misses were facts never extracted** — the kW rating, supplier
weightings, certification, board pricing decision. Retrieval was never at fault.
The entire accuracy gap is capture.

Eliminated as causes, with evidence:
- per-window cap — was real, now fixed
- `minImportance` — identical 7-fact output at 0.65 and 0.30
- `_curateDocumentClaims` — fed 7 distinct candidates it returned **7**

**Remaining:** `_extractUnified` called directly on that text returns **7 facts**;
the same text through the full pipeline persists **3**. Every downstream cap is
now cleared, so the difference must be in the window text the pipeline builds vs
the raw block used in the direct test.

**Next step:** log the exact `window.content` the pipeline passes to
`_extractUnified` for the canary fixture and diff it against the fixture.

## Strategy note
Ingest is async (202), so capture cost is invisible to the user; query latency is
the only thing they feel. Therefore: spend at ingest, and do **not** adopt
query-time LLM synthesis — that is precisely what makes cognee's search 6.6–28.2s
against our 1.7–2.1s end-to-end chat.
