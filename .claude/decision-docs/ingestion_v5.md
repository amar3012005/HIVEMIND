# HIVEMIND Ingestion — V5 Decision Record

Everything decided and built in the V5 ingestion upgrade, with rationale,
alternatives, and status. Companion to `.claude/accountability/ENGINE_CHANGES.md`
(the what-changed/is-it-live register) and the `hivemind-engine` skill ledger
(operating detail + root causes). Live build source: `/root/builds/v5-canonical`
(branch `singulance-main`). Deploy = baked image on compose project `hivemind`.

---

## 0. Goal

Make ingestion **canonical, accurate, language-neutral, and tenant-neutral** so
that every source (KB upload, connectors, chat save, meeting notes, MCP) produces
rich, well-typed, entity-linked memories that recall + chat can ground on — for
production/enterprise use, with **no brittle, deterministic, or language-specific
logic**, and **without changing any FE-facing API endpoint** so the same calls
reflect the upgrades everywhere.

---

## 1. Canonical ingestion architecture (the V5 substrate)

- **Envelope ingestion.** Every source builds a canonical envelope and calls
  `documentFirstIngestion.ingestSource(envelope)` with a `mode`:
  - `document` — long/multi-fact content -> KB distill (`_promoteMemories`, LLM
    curator) -> many fact memories + `persistCanonicalLinks` (canonical entities)
    + relationship classification. Used by KB upload, connectors, long notes.
  - `atomic` — one memory through the engine gateway (`ingestMemory`). Used by
    chat save / MCP / API / meeting sections. Routes through the smart-router
    unless `smartIngest:false`.
  - `evidence` — one recall-excluded, non-distilled raw memory (meeting
    transcript). Grounds facts by shared tag; never surfaces in recall.
- **Universal chokepoint.** All paths funnel through `createMemory`
  (`prisma-graph-store.js`), which stamps `claim_key` / `claim_subject` /
  timestamps — uniform provenance + claim identity across sources.
- **Async claim structuring** (`_structureClaimsAsync`, flag `V5_CLAIM_STRUCTURING`):
  post-commit multilingual LLM extraction of `{subject, predicate, qualifiers}`
  for clustering/graph intelligence. Off the hot path.
- **Entity resolution.** `EntityResolver` + `normalizeEntity` (NFKC + lowercase +
  slug) + `canonical_entities` registry; org-scoped `normalizedName` reuse so a
  re-encounter of a known name links to the same entity (tenant-isolated).
- **Deletion guarantee** (V5 Phase 9): hard delete purges Postgres + vector.

**Decision:** consolidate all ingestion behind the canonical envelope + universal
chokepoint rather than per-source ingest trees. **Rationale:** one place to stamp
provenance/claim identity/entities; no drift. **Alternative rejected:** bespoke
per-source pipelines (the pre-V5 state) — caused divergence and silent gaps.

---

## 2. Session decisions (2026-07-22)

### D1 — Meeting notes -> typed PartOf section-tree
**Decision.** `/api/meetings/:id/ingest` builds, from the ALREADY-computed insights
(no second LLM pass), a **parent** meeting memory (identity + participants +
1-line summary, type `event`) + **one deterministically-typed child per non-empty
section**: Decisions->`decision`, Action items/Next steps->`goal`, Open questions->
`fact`, Notable quotes->`event`. Each child is `PartOf`-linked to the parent and
entity-linked. Transcript -> separate `evidence` memory (recall-excluded).

**Rationale.** Chat synthesis cited a single combined note as one
`document_evidence` blob, so section-specific questions ("what did we decide",
"notable quotes") were unanswerable, and the old `mode:'document'` curator pass
**re-generated meaning and dropped the quotes**. Per-section typed memories make
each question answerable from the right memory, each fits the synthesis budget,
and types come from the insight **structure** (not heading text) -> language/tenant
neutral. **Alternatives rejected:** (a) `mode:'document'` distill — re-gen + quote
loss; (b) one single memory — retrieves as one blob, section questions fail against
the synthesis budget. **Status:** LIVE, verified (5 memories, PartOf edges, 5-7
entities/section; chat answers who/decide/action-items/quotes/next-steps).

### D2 — Adaptive synthesis content budget
**Decision.** In `react-agent-v2.js` synthesis, replace the flat 240-char
per-memory slice with an adaptive budget: `<=4 memories -> 1400`, `<=8 -> 700`,
`else 300` chars. **Rationale.** 240 chars made any rich memory unreadable to the
synthesis LLM — it answered "the record doesn't include that" about content it had
retrieved. Small result sets (the common case for a specific question) now show the
whole memory; large sets stay bounded (~5-6k chars worst case). Language-neutral
length policy; strengthens grounding; preserves `[REMOVED/SUPERSEDED]` markers.
Downstream of the Cerebras planner (untouched). **Status:** LIVE, verified (fixed
the ship-date/price answer that previously failed).

### D3 — Pure-insert hardening for meeting sections
**Decision.** Meeting sections ingest via the engine's `_pureInsert` fast path
(`graph-engine.js:650`) by setting ALL of `skipAdvisoryLock`, `skipPredictCalibrate`,
`skip_contradiction_detection`, `skip_relationship_classification`, `smartIngest:false`
(+ `skip_fact_extraction`). Forwarded the 3 new flags through the atomic
`ingestSource` passthrough (additive; undefined for other callers -> no change).
**Rationale.** Under the concurrent 5-section ingest, post-commit
contradiction-detection / the advisory-lock window **intermittently mangled**
section content (quotes collapsed to one line, sections dropped) — a data-integrity
regression. Pure insert = nothing to serialize, no post-commit dedup/supersede to
mangle verbatim content. Entity linking is `defer_entity_linking`-gated (NOT set)
-> canonical entities + typed edges + PartOf still land. **Gotcha:** the first
attempt omitted `skipPredictCalibrate`, so `_pureInsert` never engaged (the 3x
integrity test caught it). **Status:** LIVE, verified — 3x runs, zero content loss.

### D4 — Accurate `memory_type` at canonical creation
**Decision.** Keep `fact` as the default, but enrich the co-mention linker's
type-classification instruction (the memory-creation LLM call) with concise,
language-neutral **per-type definitions** (decision / goal / preference / lesson /
event / relationship / fact-default). The linker already **upgrades `fact`->specific
and never downgrades an explicit caller type**, so meeting-section types are
preserved while KB/chat/MCP defaults get accurately upgraded. **Rationale.** Instr.
#3 previously listed only type names -> poor accuracy. Accurate types are the
substrate for type-aware recall. **Alternative rejected:** a keyword->type map —
language-brittle. **Status:** LIVE, verified 6/6 (decision, preference, goal,
lesson, event, relationship all classified correctly).

### D5 — memory_type-aware recall/chat ("filter by type") — DESIGNED, DEFERRED
**Finding.** A rerank-boost on the retrieved set is **insufficient**: for
"what did we decide about pricing" the `decision` memory is **not generated as a
retrieval candidate** at all (it loses to co-topic memories in the base
lexical+vector+entity-hop0 candidate generation), so there is nothing to boost.
The existing `detectMemoryTypeBoost` (`persisted-retrieval.js`) is **English
keyword-based** (`decid|chose|agreed...`) -> language-brittle (a V5 violation) AND a
rerank that cannot fix the retrieval miss.
**Design (next dedicated pass, needs go — P0 recall, tenant-safe):**
  1. Language-neutral signal: the multilingual planner emits an optional
     `answer_type` (additive plan field; no change to Cerebras tool-calling
     behavior). Replaces/supersedes the brittle keyword detector.
  2. Type-scoped retrieval **lane**: when `answer_type` is set, add a candidate
     lane filtered by `memoryType` + anchored on the query's resolved entities,
     **reusing `recallPersistedMemories`'s `access_context` scoping** so it is
     tenant-safe by construction. Guarantees a type-matching candidate exists.
  3. Soft rerank boost (never a hard filter — a mis-classification must never hide
     the answer).
**Status:** designed here; not built (would rush a P0 + tenant-isolation change).

---

## 3. FE endpoint stability guarantee

**Decision.** No FE-facing API endpoint signature/route/response-contract changed.
All V5 upgrades are INTERNAL to the ingestion/synthesis logic, so the same FE calls
reflect them everywhere:
- KnowledgeBase (/upload) -> `POST /api/knowledge/upload` — unchanged.
- Connectors -> `POST /api/connectors/mcp/ingest` + `/api/mcp/*` — unchanged.
- MeetingNotes -> `POST /api/meetings/:id/ingest` — **handler logic changed
  (section-tree), response contract byte-identical** (`ok/parent_id/memory_ids/
  fact_count/transcript_evidence/source/mode`).
- Chat -> `POST /api/chat` — unchanged (synthesis budget is internal).
- MCP tool -> `POST /api/mcp/rpc` (save_memory) — unchanged.
- Generic -> `POST /api/memories` (V5 Phase 5B canonical route) — unchanged.
**Verification.** `git diff 8fe416acc..HEAD` added no `case '/api/...'`, no
`pathname ===`, no `app.(get|post|...)`, no changed `jsonResponse` shape.

---

## 4. Deploy + provenance

- **Live stack:** compose project `hivemind`, `/root/hivemind/infra/docker-compose.hetzner.yml`,
  env-file `/root/hivemind/.env` (`VERSION=` pins the image tag), baked images
  `hivemind/core-api:prod-YYYYMMDD-<sha>`. NOT quick-deploy (that manages a separate
  `hivemind-next` project on `:latest`); `.quickdeploy-last-sha` is irrelevant here.
- **Procedure:** build `-f Dockerfile.production` in the build dir -> tag current
  live `:stable` (one-step rollback) -> back up `.env` -> bump `VERSION` ->
  `docker compose ... up -d --no-deps --force-recreate core` -> health-gate.
- **Session releases:** `ac333045e` (section-tree + adaptive budget) -> `df34a73e3`
  (pure-insert) -> `011721c9a` (accurate types). All fast-forwarded to
  `origin/singulance-main`. Rollback image retained as `:stable`.

---

## 5. Verification evidence (real cURL, live tenant)

- Meeting section-tree: 5 typed memories + PartOf edges + 5-7 entities/section;
  3x integrity runs -> zero content loss.
- Multi-source company test (KB + chat + slack + mcp + meeting on shared Solvis
  topics): cross-source entity linking works (`solvispia 13`, `hannover`,
  `marco silva`, `r290` linked across sources); single-source fact recall +
  cross-source synthesis answer correctly.
- Type classification: 6/6 correct across all enum types.

---

## 6. Open items / next

- **D5 type-aware recall lane** (above) — the one remaining recall-precision gap
  ("what did we decide about pricing" returns the margin fact, not the decision).
- Language-neutral replacement of `detectMemoryTypeBoost` (English keywords).
- Residuals: `.amr`/BYOD parity suite (infra); telemetry-gated deletion of
  loud-logged fallbacks.
- **Invariant:** never touch the progressive router / Cerebras tool-calling
  behavior without explicit sign-off; keep every ingestion change language- and
  tenant-neutral; keep FE endpoints stable.
