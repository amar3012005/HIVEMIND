# `.amr` → fully self-contained single-file engine — the definitive plan

_Code-grounded against the running binding (not the strategy doc alone). Goal: one `.amr`
file per tenant resolves BOTH ingestion and recall — memories AND evidence, vector AND
lexical AND graph — so we drop global Postgres + Qdrant from the tenant hot path. Aligned to
the ICARUS Phase A–E roadmap; every phase ends in a machine-verified gate
(dual-write → read-compare on real bge-m3 → cutover), the same discipline that proved
parity 1.00 originally._

Verified this session: native symbols in `singulance-amr.*.node`, `amr-store.mjs`,
`embedded-agent.mjs`, the recall lanes. Marked **[verified]** vs **[confirm-at-impl]**.

---

## 0. Ground truth — what the shard/binding ALREADY has

**Native `MnemeStore` methods [verified from the .node]:** `insertLayered(json, vec, validFromNs, layerId)`
(layerId **0=memory, 1=evidence, 2=cognitive**), `recall(vec, limit, filter)`, `addEdge`,
`slotEdges`, `findById`, `slotText`, `rewriteText`, `recordsPage`, `liveCount`, `flush`,
`enableHnsw`, `delete`, **`compact()`** (napi symbol present; `.txt`/`.edg` compaction).
**NOT present:** BM25 / tokenizer / stemming / inverted-index / snapshot / WAL.

**In `amr-store.mjs` [verified]:** `recall` (HNSW/brute-force), `lexical()` (JS O(N) substring
over `shard.txt`, score = tokens-matched/len — no stem, no index), `graph`/`edgesOf`,
`_passesFilter` (org/user/project/**layer**/`must_not.layer`/tags/is_latest — JS-side).

**So the shard is already a fused engine for MEMORIES** (vector + substring-lexical + graph).
Evidence is the half that lives outside it.

## 1. The gap — what is OUTSIDE the shard today (must move in)

| Data | Where now [verified] | How recall uses it |
|---|---|---|
| **Evidence vectors** | Qdrant `org_<id>` (`layer:'segment'`) | `/v1/kb-recall` vector search |
| **Evidence content + pages + doc meta** | Postgres `hm.knowledge_segments` ⋈ `hm.knowledge_documents` | hydrate + title after vector hit |
| **Evidence access control** | Postgres `knowledge_documents` `scope-key:*` tags (`appendDocumentAccess`) | scope gate on read |
| **Entities + entity-links** | central `hivemind.canonical_entities`, `memory_entity_links` | entity-hop0 lane (dead for `.amr`) |
| **Relationships for recall** | agent `shard.edg` exists, but recall reads **central** `client.relationship` | graph-expansion/update-chain (dead for `.amr`) |
| **Lexical quality** | Postgres FTS (stemmed `ts_rank`) chosen over `amr.lexical()` substring | ranking parity + `known_at`/`valid_at` |

Everything above the engine — the **10 `kb-*` agent routes** (`kb-doc`, `kb-segment`,
`kb-recall`, `kb-lexical`(missing), `kb-hydrate`, `kb-docs`, `kb-doc-detail`,
`kb-doc-delete`, `kb-tables`, `kb-provenance`) — already exists. So this is a **backing-store
swap behind a stable interface**, not an API change.

---

## 2. The order (each phase gated before the next)

### Phase A — Durability (the gate; NON-NEGOTIABLE, do first)
Do NOT move more data into an unbacked, never-compacted file.
- **A1 Backup/snapshot** — ship `shard-backup.js` (written, unshipped): `flush()`-fence then
  copy the 4 files (`.amr/.vec/.txt/.edg`), keep-N, offsite target. *Gate:* kill-box → restore → recall parity.
- **A2 Compaction scheduler** — `compact()` **exists**, zero call sites → wire a cadence worker
  (like the embed-reconciler). *Gate:* `shard.vec` shrinks after churn; no recall regression.
- **A3 Observability** — per-shard size, recall p50, index staleness, compaction debt, quant drift.
- **A4 Soak** — multi-tenant write-rate burn-in beyond the one 72h pass.
- Effort: **small, days.** Independently valuable. Unblocks everything.

### Phase B — RAM headroom (prereq for evidence: 3–5× vector volume)
- **B1** Flip `MNEME_HNSW_QUANT=i8` (currently unset) — 4× RAM, ~0.5% recall, exact rerock over `.vec` recovers. One env var. *Gate:* recall@10-overlap-after-rerank unchanged; RSS drops.
- **B2** (scale, later) ADC on compressed codes → 32×. Evaluate **TurboQuant** (data-oblivious, fits append-only) vs built `mpq` PQ on the real bge-m3 corpus. Vector-RAM only — **not** durability/lexical.
- Effort: B1 minutes; B2 a spike.

### Phase C-lex-wire — Evidence INTO the shard (the single-file win; no new Rust)
Primitives exist (`insertLayered(layer=1)`, `recall(layer=evidence)`, `slotText`, `lexical`).
The real work is that **content + doc-meta + access-tags must travel IN the shard record** so
hydration and access control stop needing Postgres.
- **C1 write** — in `/v1/kb-segment`: replace the Qdrant PUT with
  `store.insertLayered(segmentJsonWithDocMeta+scopeTags, vec, validFrom, 1)`. Embed
  `{content, title, start/end_page, document_id, scope-key tags}` in the record payload.
- **C2 read** — in `/v1/kb-recall`: replace Qdrant search with `store.recall(vec, limit, {layer:'evidence', + doc/scope filter})`; hydrate from the shard record (`slotText`/payload), not the PG join.
- **C3 evidence lexical** — add **`/v1/kb-lexical`** route = `amr.lexical(text, {layer:'evidence'})` (substring today) + wire it into the remote evidence path (closes the "evidence vector-only" recall gap).
- **C4 access control in-shard** — port `appendDocumentAccess` scope logic to filter on the record's embedded scope tags.
- **Gate (the ICARUS discipline):** dual-write (shard + Qdrant/PG) → read-compare top-k on real embeddings for N docs → cut reads to shard → stop Qdrant/PG evidence writes.
- Effort: **days–2 weeks.** **← global Qdrant + PG-FTS gone for EVIDENCE here (at substring-lexical quality).**

### Phase C-recall — Revive the dead `.amr` recall lanes (parity with central hybrid)
- Graph-expansion + update-chain: add a **remote branch** in `prisma-graph-store` `listRelationships`/`getRelatedMemories` → agent `/v1/mem-relationships`/`/v1/graph` (native `shard.edg`, already exposed).
- Entity-hop0: route to shard entity records (Phase C-entities) instead of central `canonical_entities`.
- *Gate:* superseded-fact, graph-connected, entity-anchored queries return parity vs a hybrid org.

### Phase C-quality — Lexical INDEX (Rust core; the long pole, weeks)
Needed to **match** (not just replace) Postgres FTS.
- Persisted inverted index (BM25/trigram) + tokenizer + **stemming** in the Rust core (no native primitive today) → fixes `Artikelnummer`≠`Art.-Nr.` = 0-hits + the O(N) scan.
- In-shard temporal query: `known_at`/`valid_at` intersection (beyond `valid_from`).
- `.idx` sidecars (persist id-index + reverse-edge) → O(1) shard open.
- *Gate:* lexical top-k matches PG `ts_rank` on the German corpus.
- Effort: **weeks, mostly Rust.**

### Phase D — Entities + the rest into the shard (true single-file)
- Entities → shard records; `memory_entity_links`/evidence-links/derivations → `addEdge`.
- Documents/meetings/tables → layers. Cross-memory entity resolution (fuzzy, AUTO_LINK_FLOOR 0.95) in-shard.
- **PQC** signatures travel IN the record; enforce-mode (reject unsigned) + BYOK.
- *Gate:* entity + graph lanes fire wholly from shard.

### Phase E — Retire the mirrors (LAST, only after parity holds)
- Drop per-org Qdrant collection + `hm` schema mirror.
- WAL + warm standby (true HA). PQC agent-side signing on BYOD.

---

## 3. Effort + what's wire vs new-Rust (honest)

| Work | Type | Effort |
|---|---|---|
| A backup + compact-wire + observability | wire (primitives exist) | **days** |
| B1 i8 quant | env var | minutes |
| C-lex-wire evidence → shard (vector+lexical+content+access) | wire, no new Rust | **days–2wk** |
| C-recall lane revival (graph/update/entity remote branch) | wire | **days** |
| C-quality lexical BM25+stemming+filters, `.idx` | **new Rust core** | **weeks (the long pole)** |
| D entities/docs into shard + PQC enforce/BYOK | wire + Rust bits | weeks |
| E retire Qdrant/hm mirror + WAL/HA | ops + Rust | weeks |

**Distance to "evidence off global Qdrant+Postgres, one file resolves ingest+recall":**
A (days) → B1 (minutes) → C-lex-wire (days–2wk) → **done, functional, substring-lexical quality**.
**Distance to "as robust/polished as PG+Qdrant":** + C-quality (Rust lexical, weeks) + D + E.

## 4. Invariants (from ICARUS kill-conditions)
- Phase A before ANY data migration — losing data once = dead forever.
- Never regress the central path; all `.amr` work additive + flag-gated.
- Verify every cutover by **dual-write → read-compare on real embeddings**, never a code review.
- Per-tenant sub-10M is the design point; don't position as a 10M warehouse; never insertion-order-shard.
</content>
