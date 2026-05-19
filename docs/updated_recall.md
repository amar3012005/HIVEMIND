# HIVEMIND Recall v2 — Updated Architecture

**Status:** Live in production
**Endpoint:** `POST /api/recall`
**Commits:** `9958263` (orchestrator) · `dea4018` (slim default)
**Last updated:** 2026-05-19

---

## Why a new recall

Original `/api/recall` returned canonical memories only. Two problems:

1. **No provenance** — recall surfaced "what we believe" but never "where it came from"
2. **Bloated payload** — 22KB per call, 33 keys per memory (vector_score,
   graph_score, keyword_score, policy_score, expansion_metadata,
   parent_chunk, injection_text, user_profile, …)

Recall v2 solves both: orchestrates memories-first with evidence on-demand,
returns 5× smaller payload (~4KB), keeps full output available via
`verbose: true`.

---

## Two-layer architecture

```
┌────────────────────────────────────────────────────────┐
│  CANONICAL MEMORY LAYER (BUNDB AGENT collection)       │
│  "what the company believes"                            │
│  - distilled facts, decisions, events                   │
│  - relationships: Updates / Extends / Derives /         │
│    Contradicts                                          │
│  - tagged with entity:<name>, heading:<slug>            │
└────────────────────────────────────────────────────────┘
                          ↕  memory_evidence_links (FK)
┌────────────────────────────────────────────────────────┐
│  EVIDENCE LAYER (hivemind_evidence collection)          │
│  "where it came from"                                   │
│  - knowledge_segments + knowledge_documents             │
│  - immutable, full text, page + heading metadata        │
│  - source_artifacts hash for dedup                      │
└────────────────────────────────────────────────────────┘
```

**Never merged.** Two collections, two purposes. Recall walks across them
through `memory_evidence_links` SQL join.

---

## Recall modes

```
POST /api/recall
{
  query_context: string,         // the actual query text
  max_memories: number,          // default 5
  mode: 'auto' | 'memory' | 'evidence' | 'hybrid',  // default 'auto'
  verbose: boolean,              // default false (slim)
  tags?: string[],
  project?: string,
  project_id?: string,
  source_platforms?: string[],
  ...
}
```

| Mode | What runs | When to use |
|---|---|---|
| `memory` | searchMemories only | Fast path, no citations needed |
| `auto` (default) | memories + auto evidence | Default for nearly all queries |
| `hybrid` | memories + evidence (always) | Explicit "show me both" |
| `evidence` | evidence only (no memories) | Citation-only lookup |

---

## Auto-mode trigger logic

```js
const sparseMemories = memoryHits.length < 3;
const citationIntent = /(cite|source|proof|where|why|evidence|reference)/i
                       .test(query_context);

shouldFallback =
     mode === 'evidence'
  || mode === 'hybrid'
  || (mode === 'auto' && (sparseMemories || citationIntent));
```

### Decision examples

| Query | memory_hits | citation word | fallback? |
|---|---|---|---|
| "Stripe billing" | 3+ | — | ❌ |
| "Alice Wong" | 3+ | — | ❌ |
| "where is the source X" | any | ✅ | ✅ |
| "who leads phoenix proof" | any | ✅ | ✅ |
| "obscure xyz term" | 0-2 | — | ✅ |

---

## Pipeline

```
1. searchMemories(query, top_k=20)
     filter: user_id, org_id, project_ids, tags
     returns: memories[] with scores
     score boosts: cognitive operator weights, fact extraction tags

2. SQL join: prisma.memoryEvidenceLink.findMany({
     where: { memoryId: { in: memHitIds } },
     select: { segmentId, documentId, linkType, confidence, excerpt,
               document: { id, title, sourcePlatform } }
   })
   attach per-memory under `evidence: [...]`

3. IF shouldFallback:
     evidenceRetrieval.retrieveEvidence(query, limit=10)
     dedupe against segments already FK-attached
     surface deduped segments under top-level `evidence: [...]`

4. Slim transform (unless body.verbose):
     - Memory: keep 11 keys (id, title, content, memory_type, tags, score,
       created_at, document_date, project, source, evidence)
     - Top-level: drop injectionText, user_profile, expansion_stats, dedup,
       query_rewrite, intent
     - Evidence: trim to { segment_id, document_id, document_title, score,
       snippet (200 chars) }
```

---

## Response shape (slim default)

```jsonc
{
  "memories": [
    {
      "id": "uuid",
      "title": "string",
      "content": "string",
      "memory_type": "fact|decision|event|synthesis|...",
      "tags": ["..."],
      "score": 1.236,
      "created_at": "ISO",
      "document_date": "ISO|null",
      "project": "string|null",
      "source": "string|null",
      "evidence": [                          // FK-attached, inline
        {
          "segment_id": "uuid",
          "document_id": "uuid",
          "document_title": "string|null",
          "source_platform": "string|null",
          "link_type": "supports",
          "confidence": 0.9,
          "excerpt": "string"
        }
      ]
    }
  ],
  "evidence": [                              // fallback bucket, deduped
    {
      "segment_id": "uuid",
      "document_id": "uuid",
      "document_title": "string|null",
      "score": 0.78,
      "snippet": "string ≤200 chars"
    }
  ],
  "evidence_count": 10,
  "mode_used": "auto",
  "search_method": "persisted-recall"
}
```

Verbose mode (`body.verbose=true`) returns original 33-key shape for
debugging.

---

## Performance

| Metric | Before v2 | After v2 |
|---|---|---|
| Bytes (typical) | 22,246 | 4,328 |
| Top-level keys | 11 | 5 |
| Memory keys | 33 | 11 |
| Evidence call (no need) | always | **skipped** |
| Evidence call (citation) | always | fires once |

Slim mode saves ~80% bandwidth + parsing time. Auto-mode saves one Qdrant
call per non-citation query.

---

## MCP hivemind_recall integration

`hosted-service.js` recall tool now passes `mode: 'auto'` by default.
Response includes evidence inline:

```jsonc
{
  "memories": [{ ..., "evidence": [{...}] }],
  "evidence": [{...}],
  "evidence_count": 10,
  "mode_used": "auto"
}
```

Claude / Cursor / any MCP client gets canonical truth + provenance in
one call.

Override via tool arg:
```js
hivemind_recall({ query: "...", evidence_mode: "memory" })  // fast
hivemind_recall({ query: "...", evidence_mode: "hybrid" })  // always both
```

---

## Quality test results (2026-05-19)

### Q1: "Stripe billing" (no citation intent)
```
[1] 1.236  We use Stripe for payments.
[2] 1.159  Stripe is used for payments in Project Phoenix.
[3] 0.998  Stripe billing is operational for Project Atlas.
evidence: 0  ← auto-skipped, dense memories
```

### Q2: "Alice Wong" (no citation intent)
```
[1] 1.211  Alice Wong and Sarah Chen lead Project Phoenix.
[2] 1.068  Alice Wong leads Project Atlas.
[3] 1.000  Alice Wong shipped Project Atlas on time.
evidence: 0  ← auto-skipped
```

### Q3: "who is in charge of Project Phoenix proof source" (citation intent)
```
Memories:
[1] 1.135  Acme Corp is a partner in Project Phoenix.
[2] 1.084  Stripe is used for payments in Project Phoenix.
[3] 1.064  Alice Wong and Sarah Chen lead Project Phoenix.

Evidence (10 deduped segments):
[1] test-entity.md  → "Lead engineer is Alice Wong (@alicew)..."
[2] test-link.md    → "Alice Wong (@alicew) leads Project Phoenix at Acme..."
[3] test-topic.md   → "Alice Wong moved Phoenix from staging to..."
evidence: 10  ← fired by citation intent
```

---

## Why we did NOT merge collections

Considered: single `hivemind_unified` collection with `payload.kind ∈
{memory, segment}`.

Rejected because:
- **Ranking dilution** — segments outnumber memories 30:1, sink the
  high-value memory results
- **Schema bloat** — payload union of both shapes
- **Loss of promotion semantics** — "memory = curated truth" mental model
  breaks
- **Bigger index** — HNSW slower on combined volume

Current design preserves: memories = belief, evidence = proof, joined
through FK.

---

## Future: turbovec rerank seam (deferred)

When corpus > 1M memories or p95 > 300ms, add second-stage rerank:

```
Stage 1: Qdrant (HNSW + filter) → 500-1000 candidates
Stage 2: turbovec (PQ-quantized rerank) → top 20-50
Stage 3: graph-engine boosts → final ranking
```

Not built. Feature-flagged seam will be added when scale demands.

---

## File map

| File | Role |
|---|---|
| `core/src/server.js` `case '/api/recall'` (line 11264) | Route handler |
| `core/src/memory/persisted-retrieval.js` | `recallPersistedMemories` — stage 1 search |
| `core/src/knowledge/evidence-retrieval.js` | `retrieveEvidence` — fallback evidence search |
| `core/src/vector/qdrant-client.js` `searchMemories()` | Qdrant ANN call |
| `core/src/mcp/hosted-service.js` `case 'hivemind_recall'` | MCP tool wrapper |

---

## Open follow-ups

1. **Graph-edge boosts**: +0.15 for memories with Contradicts edges in window
2. **TopicState boost**: +0.10 if memory matches current rolling topic
3. **Stale penalty**: −0.05 for memories with `strength < 0.3`
4. **Promotion loop**: evidence segments hit ≥3× without memory → promote
5. **Hybrid score normalization**: memory ×1.2, evidence ×0.7 weighting

Tracked in `PHASE2_FINAL_INTEGRATION_PLAN.md` Wave B.

---

## TL;DR

- **One endpoint** `/api/recall` handles all modes
- **Auto-orchestrates** memories-first → evidence on demand
- **Triggers**: sparse memories OR citation intent (cite/source/proof/where/why/evidence/reference)
- **Slim by default**: 5× smaller payload, 11 keys per memory, 5 top-level
- **MCP integration**: `hivemind_recall` returns evidence inline automatically
- **Two collections preserved**: BUNDB AGENT (memories) + hivemind_evidence (segments), joined via `memory_evidence_links`
