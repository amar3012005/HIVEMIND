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

## Storage backends — half the tenants are NOT in Postgres
`organizations.memory_storage_mode`: **6 orgs `amr_embedded`, 6 `hybrid`, 1 `byod_amr`.**
`hybrid` writes to Postgres; `amr_embedded` writes to the `.amr`/mneme store on the
`hivemind-data` volume (`/app/data/mneme/<orgId>/`).

Any verification that asserts Postgres invariants reports a confident FAIL for a
document that ingested perfectly. Observed on boozit (`40da0836`, pro,
`amr_embedded`): the ingest log read `✓ doc=689f15da segs=1 promoted=2` while every
Postgres table was legitimately empty. The canary now detects this and says so
instead of failing blind — but **it still cannot verify an amr org**. Asserting
against the mneme store is unbuilt and is the single biggest coverage gap in this
audit: ~46% of tenants are unverified.

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

**Measurement was contaminated — now fixed.** The canary reused a byte-identical
fixture every run, so its CLAIMS deduped against prior runs even though the
document was unique. Traced live: 7 extracted → 7 curated → only 3 persisted,
purely because earlier runs had stored the other 4. The canary now randomises the
stated values per run and reports capture as a fraction of `FIXTURE_FACT_COUNT`.

**True capture rate: 3/7 (43%), stable across three consecutive runs.**

Also measured: **extraction is non-deterministic** — the identical call on the
identical segment returned 5 and 7 facts on different runs. Do not tune to a
single observation.

**Remaining:** the pipeline segment is 708 of 711 chars (the whole document), the
window allows 8 facts, `_extractUnified` on that exact segment returns 5-7, and
curation preserves all of them (7 in → 7 out) — yet 3 persist. The drop is in the
per-claim persist loop, where `_ingestUnifiedWindow` returning nothing is silently
skipped (`if (!memory) continue;`). Semantic near-duplicate suppression against
prior memories is the leading suspect, since randomising numbers still leaves the
claims semantically near-identical.

**Next step:** instrument that loop to log which claims return no memory and why,
or run the canary against a `hybrid` org with no prior Solvis content.

## Strategy note
Ingest is async (202), so capture cost is invisible to the user; query latency is
the only thing they feel. Therefore: spend at ingest, and do **not** adopt
query-time LLM synthesis — that is precisely what makes cognee's search 6.6–28.2s
against our 1.7–2.1s end-to-end chat.
