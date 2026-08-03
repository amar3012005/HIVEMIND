# /upload — KB ingestion: full state, defects, and plan

Single source of truth for the upload path. Every number here was measured in this
codebase against real tenant data, not estimated. Where a supermemory convention is
adopted it is because it measured better; where rejected, that is stated.

**Status line:** P1 (evidence-first recall) is LIVE at `sha-af83f6c5c` —
`scripts/recall-detail-canary.sh` passes 5/5. **P0 and P2–P7 are untouched.** The
ingestion side of this document is still entirely to do.

---

# PART 1 — CURRENT STATE

## 1.1 What is live

| | value |
|---|---|
| core image | `hivemind/core-api:sha-af83f6c5c` |
| deployable ref | `singulance-main` (only) |
| rollback | `hivemind/core-api:rollback-before-p1` |
| orgs by storage mode | `hybrid` 6 · `amr_embedded` 6 · `byod_amr` 1 → **54% NOT hybrid** |
| corpus | `1380251c` 1051 segs / 485 memories / 34 docs · MANDI 949 segs · **11 of 13 orgs have 0–1 segments** |

## 1.2 The reference document (used for every before/after in this doc)

`Solvis_ Elektrifizierung _ Transformation_ White Paper …pdf`, 54 pages, German,
figure-heavy. Source bytes retained (4.2 MB at `kb-store/<org>/fc7d7173…/`).

```
word_count 7584 · segments 103 · memories 16 · entities 45
```

## 1.3 The finding that frames everything

Five small-detail questions (a price, a part number, a kW rating, a surname, a meter
model). Direct SQL over the whole org:

| fact | in memories | in segments |
|---|---|---|
| `13.050 €` | **0** | 3 |
| `18.500 €` | **0** | 3 |
| `Art.-Nr. 35113` | **0** | 2 |
| `E3DC` | **0** | 34 |
| `Jablonski` | **0** | 2 |
| *totals* | 485 rows | 1051 rows |

**Zero of 485 memories contained any of them. All five were in segments.** Not a
retrieval failure — those facts were never extracted. Recall now compensates by reading
source text (P1). Ingestion is why it has to.

---

# PART 2 — DOCLING

## 2.1 Is Docling robust? Measured answer: yes at parsing, no at chunking.

Docling's **layout analysis, table structure and picture description are good** and hard
to replace. Its **HybridChunker is not usable as-is.**

## 2.2 Every Docling defect found, with evidence

**D1 — `smart` defaulted false, so Docling never ran.** The first fix guarded on
`smartOpt !== false` and was a **silent no-op**, because every layer coerces to a strict
boolean and an absent form field arrives as explicit `false`. Fixed by making the env var
the opt-out, not the argument. *Lesson recorded: the opt-out must be the env var.*

**D2 — OOM at `mem_limit: 2g` against a 3.1 GiB peak.** Nine container restarts, poll
404s that looked like application bugs. Now `9g`, 3 workers, `MAX_SYNC_WAIT=900`,
`OMP_NUM_THREADS=2`.

**D3 — one bucket for all layout formats.** PPTX took **603s** and produced zero
memories. Replaced by per-format `FORMAT_PROFILES` (`server.js`) choosing
`smart`/`ocr`/`tables`/`pics` per extension. PPTX → **27.6s**, same 13 memories.

**D4 — DOUBLE CONVERSION, still live.** `server.js:1862 parseWithDocling` and
`:1868 chunkWithDocling` run in **one `Promise.all`** — two full conversions of the same
file. The chunker's output is then **discarded** whenever `KB_SEMANTIC_SEGMENTS` is on
(the default). This is pure waste plus two live failure modes (`chunkerError`, the 180s
chunker abort).

**D5 — HybridChunker cuts mid-word.** Documented at `document-first-ingestion.js:2805`
and confirmed in old segment data: `"th labels like"`, `"ts a heat pump"`,
`"nschluss an SolvisMax"`, `"visBruno7kW"`. Token-window artifacts that poison both the
evidence layer and the embeddings. **This is why the semantic re-slice exists — do NOT
"fix" it by flipping `KB_SEMANTIC_SEGMENTS=false`.**

**D6 — the parse-failure gate could discard a good parse.** Now:
`parseFailed = usableChunks === 0 && (error || usableChars < 200)`.

## 2.3 Is Docling worth the compute? Yes — but stop paying twice.

Cloud document APIs price at roughly $10–50 per 1k pages. Docling + our own vision path
runs at **~$0.94/1k pages** for figure-rich PDFs. The compute is defensible; the *double*
conversion is not. Killing D4 halves Docling cost immediately.

## 2.4 Formats that should NOT go through Docling

| format | route | measured |
|---|---|---|
| `xlsx xls xlsm ods` | **`sheet-direct`** (SheetJS) | **47ms vs 2040ms**, grid preserved |
| `csv tsv` | csv direct | — |
| images | vision → ONE atomic memory, no evidence rows | fragmented `§1/3` before the fix |
| audio | whisper | speaker/timestamp segments still to do |
| everything else | Docling, **once** | |

---

# PART 3 — CHUNKING EFFICIENCY

## 3.1 The document is chunked THREE times, none aligned

| pass | size | overlap | fate |
|---|---|---|---|
| Docling HybridChunker | token-window | — | **discarded** (D5) |
| semantic segments | `KB_SEGMENT_CHARS=700` | `120` | **this is the evidence layer** |
| extraction windows | `KB_UNIFIED_WINDOW_CHARS=2500` | **`0`** | fed to the LLM |

Three independent chunkings means provenance is guessed rather than known, and the same
text is embedded, re-sliced and re-sliced again.

## 3.2 Efficiency defects

**C1 — extraction windows have ZERO overlap.** `overlapSize: 0`. A claim whose subject
is in window N and predicate in N+1 is seen whole by neither. This is mechanically the
`"Fehlende Elektro-Kompetenz"`-with-no-owner defect.

**C2 — window→segment provenance is a positional guess.**
`segmentId: promotableSegments[Math.min(i, promotableSegments.length - 1)]`. Segments are
700 chars, windows 2500 — ~3.5× more segments than windows, so window *i* does not
correspond to segment *i*, and `Math.min` clamps every overflow onto the **last** segment.
Mitigated by `resolveEvidenceSegment` matching the quote; unmitigated whenever the quote
doesn't match, which silently cites the wrong paragraph.

**C3 — windows may span section boundaries**, so a window's heading is ambiguous even
once we start populating it.

---

# PART 4 — METADATA-AWARE CHUNKING

## 4.1 The schema already has everything. The writer fills in nulls.

`KnowledgeSegment` (`core/prisma/schema.prisma:1755`) already declares, **with an index**:

```prisma
segmentType  String  @map("segment_type")  // 'heading' | 'paragraph' | 'table' | 'code_block' | 'message' | 'chunk'
depth        Int     @default(0)           // heading depth, nesting level
startPage    Int?    @map("start_page")
endPage      Int?    @map("end_page")
metadata     Json    @default("{}")        // heading level, table structure, code language, etc
@@index([segmentType])
```

Live data:

```json
{"source": "semantic_chunk", "heading": null}      segment_type = 'structured'
```

`'structured'` **is not even in the documented enum.** `heading` is null on most rows,
pages are null. So the metadata-aware model was designed in from the start and never
written to.

**Consequence: populating it is ZERO migration and cannot regress anything** — filling a
null column is strictly additive. This is the cheapest high-value change in the plan.

## 4.2 What metadata-aware segmentation must produce

```
heading_path[]   ["Use-Case", "Wallbox"]      full hierarchy, not one heading
page             43                            offset→page map from the parse
segment_type     table|figure|heading|paragraph|list     honest, not 'structured'
depth            2                              heading nesting
section_id       → PartOf edge                  the section tree
char_start/end   exact offsets                  kills C2's positional guess
lang             deterministic detection        7-language function-word detector
```

Correction on record: the `docling_hybrid` fallback branch (`:2891/:2910`) **already
carries `page`**. The gap is that the *semantic* path — the default — does not.

## 4.3 Tables must stay tables

`document_tables` / `document_table_rows` shipped and are verified live
(`sheet=Tabelle1 row_count=43 cols=5`, cells keyed by real headers, GIN on `cells`,
`org_id` on both). A spreadsheet's questions are "how many / which is highest / what is
the value for X" — none answerable by similarity over prose.

**Two open defects:**
- **T1 — rows are ungroundable.** Columns are `document_tables(document_id, org_id,
  user_id, sheet, table_index, headers, row_count)` and `document_table_rows(table_id,
  org_id, row_index, cells)`. **No `section_id`, no `page`, no offsets, no link to a
  summary segment.** An exact SQL count cannot cite where it came from.
- **T2 — not in `ROUTED_MODELS`** (see 7.2). My defect, introduced this session.

---

# PART 5 — EVIDENCE SEGMENTATION

## 5.1 Why segments are the robust layer (measured, not asserted)

**Nothing ever decided they were important.** Every lossy step in ingestion is a decision
about importance made *before the question exists*. `Art.-Nr. 35113` is worthless until
someone needs that part.

1. **Verbatim, not paraphrased** — 0 of 485 memories held the five facts; all were in
   segments.
2. **Segmentation is lossless by construction; extraction is lossy by design** — segments
   pass zero gates, memories pass three (§6.2).
3. **Redundancy** — `E3DC` appears in **34** segments; 120-char overlap means a fact
   usually lands in more than one.
4. **Concentrated embeddings** — a 700-char segment about SolvisBruno specs is *mostly*
   that; a memory saying "Solvis offers heat pump packages" is near everything and close
   to nothing.
5. **Plays to the cross-encoder** — it can see `Teillast = 3,7` next to the question. It
   cannot see a number a paraphrase omitted.
6. **Provenance is intrinsic** — a segment *is* the citation.

## 5.2 What segments cannot do

Synthesis across a corpus · temporal (`what changed` — segments are immutable, only
memories carry `is_latest`) · counting (a segment set is a sample) · contradiction
resolution. **Segments are for stated fact; memories are for derived truth.**

## 5.3 P1 (LIVE) — what was fixed on the retrieval side

| defect | fix | evidence |
|---|---|---|
| `limit` sized both fetch and slice | split `depth`/`deliver` (150/40) | pool recall 1→6, 2→11, 0→8 |
| lexical score DISCARDED when vector had the segment | merge, take max | `SPiNE` hits 24/24/**17** → 24/24/24 |
| `deliverUnifiedV2` biased against evidence | deleted; one `deliverHybrid` | boosts were memory-only ×2.0 vs ×1.0 |
| `hop2Evidence` three-way gate | unconditional | `ev_in=0` → 40 |
| `expand_evidence` false for mode `fact` | `fact` includes evidence | **this was the real gate** |
| degraded fallback sorted incomparable scores | interleave lanes | fixed the cross-lingual `E3DC` miss |

**Cost: 4 production deploys**, because three gates in series each returned an empty
result indistinguishable from "nothing to find". Ended by ONE counter:
`[recall-hybrid] ev_in=…`. `scripts/recall-detail-canary.sh` now asserts **both** the
answers and `ev_in > 0`, because each regression passed one check and failed the other.

---

# PART 6 — MEMORY GENERATION

## 6.1 Live configuration (differs from code defaults — always check both)

```
KB_UNIFIED_DOC_CAP=24            code default 30
KB_UNIFIED_WINDOW_CHARS=2500     code default 1500
KB_FACTS_PER_1K_CHARS=6          code default 12
KB_UNIFIED_MIN_IMPORTANCE=0.65
KB_CURATED_MEMORY_CAP=0          the =8 defect IS fixed
KB_UNIFIED_MODEL=openai/gpt-oss-120b
```

## 6.2 THE headline defect: ~80% of every long document is never sent to the LLM

```js
let uBudget = DOC_CAP;                                 // flat 24
while (wi < uWindows.length && uBudget > 0) { … }      // exits on BUDGET, not on windows
```

62,867 chars ÷ 2500 = **~25 windows**. Per-window grant `min(UWMAX 10, 2.5×6=15)` = 10.
Budget 24 is reserved by ~3 windows and stretches to ~4–5 via `uBudget += grant - got`.
**Windows ~6–25 are never sent. No log line.** `_dynamicCap = min(30, ceil(24×0.7)=17)`
reconciles exactly with the 16 memories observed.

Three lossy gates in total: **DOC_CAP truncation → `MIN_IMPORTANCE=0.65` → the curator's
70% cap.**

## 6.3 The density target, derived from supermemory

Their console, one 15-page persona PDF: **83 memories from 20 chunks** = 4.15 per chunk,
≈ **1.8 facts per 1,000 chars**. Ours: 103 segments → 16 memories = **0.17 per segment**.

So: **`DOC_CAP ≈ ceil(chars / 550)`.** The reference deck should yield ~115 memories, not
16. Note our per-window *rate* (`FACTS_PER_1K`) is already higher than their output — the
flat cap is the whole problem.

They also concede our defect in their docs: *"if documents are too long, fewer memories
get generated"* — and tell customers to split documents. Most of this corpus is long
documents, so fixing it properly beats their guidance.

## 6.4 Memory SHAPE is wrong, not just the count

Theirs, one attribute each, subject-prefixed, ~10 tokens:

```
Peter Stahlgrimm age 58.
Peter Stahlgrimm residence Unna.
Peter Stahlgrimm annual revenue 1 million EUR.
```

Ours are sentence-length prose with an importance score. `CHAT_TOP_MEMORY_CHARS=8000` for
the **top three** — ~2,000 tokens for 3 facts, where they deliver 50 facts in 500.

Three consequences:
- **`MIN_IMPORTANCE` is incompatible with atomic facts.** `"Peter Stahlgrimm age 58"`
  scores low by any LLM's judgement and is exactly what answers "how old is Peter?".
  **Delete the gate, don't tune it.**
- **The curator must go.** `_curateDocumentClaims` discards 30% by LLM judgement.
  Supermemory's own rule: *"Don't pass content through an additional LLM."* Replace with
  deterministic dedup (exact text, then embedding cosine > 0.97 in-document).
- **Atomicity makes supersession definable.** With prose, "latest" is ambiguous; with
  `Peter Stahlgrimm | age | 58` the key is exactly `(org, entity, attribute)`.

## 6.5 Extraction runs blind

```js
claims = await this._extractUnifiedReliable(w, { entityContext: '', maxFacts, docTitle });
uWindows = uc.map((content, i) => ({ …, heading: null, page: null, … }));
// and again in the persist path:  sourceWindow = { …, heading: null, page: null }
```

`entityContext` is passed as an **empty string** — supermemory exposes that exact field
publicly (max 1500 chars) as their anti-drift primitive. `heading` and `page` are
hardcoded `null` in **two** places, so fixing one is a silent no-op.

## 6.6 Where LLMs are used (and where they must not be)

| step | LLM | verdict |
|---|---|---|
| `_extractUnified` (per window) | `gpt-oss-120b` | **keep** — deepseek-v4-flash fabricated 230 for 180 |
| `_curateDocumentClaims` | flash-tier | **delete** — lossy second judgement |
| doc classification | heuristics | keep |
| entity resolution | LLM today | **replace with lookup** (§8) |
| relationship assertion | none today | **add, typed + grounded** (§9) |
| rerank | `cohere/rerank-v3.5` | **keep, verified working** |

Grounding gate that must never be removed: `content.includes(item.source_quote)`.

---

# PART 7 — ENTITIES

## 7.1 The graph is starved, not broken

```
2,176 entities · 1,229 with ZERO mentions (56%)
hannover · germany · berlin · europe · uwe berger  → 4 duplicate rows EACH
```

`hivemind_aggregate_entities` and `hivemind_traverse_graph` are **built and correct** —
they return `parent_entity_not_found` because the data is absent.

Related fix already shipped: `ENTITY_EXTRACT_MAX_TOKENS` 800 → 4000 (truncated JSON made
`JSON.parse` fail so extraction returned `[]`), plus a salvage that rebuilds a truncated
array. Measured **0 → 33 candidates**.

## 7.2 Entity resolution is a LOOKUP, not reasoning

An LLM here produced the 4× duplicates. Correct algorithm:

1. normalize — lowercase, strip punctuation, **PRESERVE umlauts**
   (`jaccardTokens` does `replace(/[^a-z0-9\s]/g,' ')`, which shreds `ladesäulen` → `landes`/`ulen`)
2. exact match on `canonical_name` or alias within org → link
3. embedding cosine above a **high** threshold → link + add alias
4. else create canonical

**Guards:** auto-alias requires corroboration in **≥2 distinct documents** before it is
permanent; **never auto-merge two existing canonicals** (destructive — queue for review);
log `[kb-entity] new_canonical=N new_alias=M provisional=K` and watch per-org alias growth.

## 7.3 Storage routing gaps (BOTH must close before entity work)

`ROUTED_MODELS` (`core/src/vector/mneme/prisma-proxy.js:18`) contains `memory`,
`relationship`, `knowledgeSegment`, `entityMention`, `memoryEntityLink`,
`knowledgeDocument`, `vectorEmbedding` … and **not**:

- **`Entity`** (schema:1948) → for `.amr` tenants, mentions land in the tenant store while
  the canonical row lands **centrally**. Split-brain; Stage 4 would join across two stores.
  **Needs an owner decision — data residency, not code.**
- **`DocumentTable` / `DocumentTableRow`** → spreadsheet cells for 7 of 13 orgs are written
  to central Postgres. Not cross-tenant readable (`org_id` on both), so a **placement**
  violation, not a leak — but exactly what a BYOD tenant chose `.amr` to avoid.
  **My defect, introduced this session.**

---

# PART 8 — RELATIONSHIPS

## 8.1 Current state

Edges are derived **deterministically** from shared non-common entities. No LLM asserts
an edge. Cheap and hallucination-free, but untyped and noisy. `Updates` + `is_latest`
exist; **`Extends` and `Derives` do not**.

## 8.2 Where each scope belongs — forced by context-window physics

| scope | both endpoints in one prompt? | mechanism | cost |
|---|---|---|---|
| intra-window | **yes** | same call as extraction | free |
| intra-document | no — window 3 vs 17 | **one extra call over the atomic fact list** | ~1.7k tok/doc |
| cross-document / temporal | no — needs the corpus | recall-anchored, batched **by entity**, async | 1 recall + 1 call per entity |

- Intra-window belongs in the extraction call — the model already has both facts and can
  quote the edge. A second pass could only lose context.
- Intra-document **cannot** be in that call, because window 17 doesn't exist when window 3
  runs and serialising windows destroys the 4-way concurrency. **Atomicity is what makes
  this affordable** — 115 ten-token facts fit in one prompt; 115 prose claims do not.
- Cross-document is a retrieval problem by definition. Batching by *resolved entity*
  collapses ~115 recalls into ~15.

Deterministic shared-entity edges stay as a **floor**, typed `co_mention`, ranked below
asserted quoted edges.

## 8.3 Invariants

- Supersession key `(org, scope, entity_id, attribute)`, enforced by a **partial unique
  index** `UNIQUE (org_id, entity_id, attribute) WHERE is_latest` — unfalsifiable rather
  than dependent on code discipline. The Stage C work already shipped a `flag-on-insert`
  bug here.
- Flip + insert in ONE transaction, idempotent under retry.
- `Derives` is `inferred=true`, has **no** `source_quote`, is **barred from citation**, and
  is **excluded from supersession** — an inferred fact must never supersede an observed one.

---

# PART 9 — THE PIPELINE (target)

```
   FE: N files ──► 1. precheck ALL N checksums (no bytes)
                   2. upload only non-duplicates
                   3. poll ONE batch endpoint
 ══ STAGE 0 · ADMIT (sync/file) ════════════════════════════════════════════
 filename/MIME/bytes/buffer-sniff → scope authZ (ORG FROM KEY, never payload)
 → storage mode (no central fallback) → quota kbPages
 → checksum dup → 409 {duplicate:true}
 → persist bytes + retained_at → job row → BullMQ `kb-ingest`
 → 202 {job_id, document_id, batch_id, status:'queued'}
 ══ STAGE 0.5 · BULKQM ═════════════════════════════════════════════════════
 one batch_id; batch_seq at admit
   parse/segment → PARALLEL (Docling 3 workers, CPU-bound)
   memory phase  → ORDERED by batch_seq within a scope
                   └─ ordering is what makes `Updates` edges resolve
 backpressure → 429+retry_after ; reap on HEARTBEAT not wall-clock
 ══ STAGE 1 · PARSE — ONCE ═════════════════════════════════════════════════
 FORMAT_PROFILES[ext]; keep markdown + tables + pages + hybridChunks from ONE
 response.  ✗ DELETE chunkWithDocling
 ══ STAGE 2 · SEGMENT — metadata-aware, ONE chunking ═══════════════════════
 SECTION TREE from headings; ~700/120 split only at paragraph/sentence edges,
 NEVER across a section; snap mid-word hybrid boundaries to a word edge
 populate heading_path · page · segment_type · depth · section_id ·
          char_start/end · lang        ← all already in the schema
 tables → document_tables/_rows + ONE summary segment
 embed → per-tenant, layer=evidence  +  FTS to_tsvector('simple', …)
              ★ SEARCHABLE HERE → status `done`   (memory count ≠ doneness)
 ══ STAGE 3 · EXTRACT — atomic facts + entities + intra-window relations ═══
 window = N CONTIGUOUS SEGMENTS INSIDE ONE SECTION (~2500ch, 200 overlap)
 carries heading_path, page_range, doc_summary, entityContext, offsets
 budget DOC_CAP = ceil(chars/550); log windows_total/processed/exhausted
 ATOMIC: one attribute, subject-prefixed, ~10-20 tokens
 gate: content.includes(source_quote)
 ✗ DELETE MIN_IMPORTANCE   ✗ DELETE the curator's 70% cap
 ══ STAGE 4 · ENTITY RESOLUTION — deterministic, NO LLM ═══════════════════
 ══ STAGE 5 · RELATIONS — 5a intra-window / 5b intra-doc / 5c cross-doc ═══
 ══ STAGE 6 · DREAMING (async, non-blocking) ══════════════════════════════
 `enrichment` is a SEPARATE field: pending→running→done, never regresses `done`
```

## 9.1 API surface (supermemory-compatible payload, our isolation)

```
POST /api/knowledge/upload            multipart, 50 MB
POST /api/knowledge/documents         json { content }
  customId  containerTag  metadata  filterByMetadata  entityContext
  taskType: memory|superrag        (superrag = chunks only, ~5× cheaper)
  dreaming: instant|dynamic
GET  /api/knowledge/documents/{id}         queued|extracting|chunking|embedding|done|failed
GET  /api/knowledge/documents/processing   WHOLE batch, one poller   (NEW)
POST /api/knowledge/documents/list · PATCH/DELETE /{id} · DELETE /bulk
POST /api/knowledge/upload/precheck        checksum only, O(1)
```

**`containerTag` is a namespace INSIDE an org.** Org comes from the scoped API key,
server-side. Their client-supplied-boundary model would fail CLAUDE.md Gate 2.

**Stage → status mapping** (so `extracting` never comes to mean two things):
admit→`queued` · parse→`extracting` (**text out of the FILE**) · segment→`chunking` ·
embed+FTS→`embedding` · searchable→`done` · Stages 3–6→`enrichment: running`.

**Idempotency:** `checksum` identifies **bytes** `(org, scopeKey)`, computed server-side.
`customId` identifies the **logical document** `(org, containerTag)`. `customId` is the
identity key; checksum decides no-op vs new version. When `customId` is present, byte-dedup
must **not** reject — a growing transcript has different bytes every ingest. One `customId`
never maps to two documents. Build on the existing `processingVersion`.

**Precheck is currently an existence oracle** — `findDuplicate` intentionally drops
`scopeKey` ("anywhere in this org"). Fix: readable-scope match → `duplicate:true` + title;
out-of-scope match → `duplicate:"maybe"` with **no** title/scope/id. Keep fail-open.

## 9.2 Where we deliberately diverge from supermemory

- Tenant boundary **server-derived**, never a client string.
- **Checksum precheck + `409 duplicate:true`** — they document no dedup or idempotency.
- **SQL over structured data** — they state *"no SQL over memories, no joins, no aggregates."*
- **`is_latest` history** instead of *"Deletes are permanent — no recovery."*
- **`DOC_CAP` scales with length** instead of telling customers to split documents.
- **700-char segments** for precision over their ~20-chunks-per-document coarseness.
- **No client-facing `searchMode`** — measured: the cross-encoder chose a segment over a
  memory 5/5 unprompted, so a mode parameter and lane weights are unnecessary.

---

# PART 10 — PLAN

Ordered by reversibility, because **additive parameters are reversible and transformative
ones are not.** Raising `DOC_CAP` produces *more of the same shape* — flip it back and
nothing is corrupt. Atomic facts produce a *different shape* — only re-ingestion undoes
that, which is possible solely because source retention shipped (`295594e54`) and
selective solely because of `pipeline_version`.

**Read-side flags are a true rollback. Write-side flags are not a time machine.**

## P0 — Rails + baseline. ZERO behaviour change.
- `pipeline_version` column (additive, default 1) on documents/segments/memories
- `progress_at` heartbeat + per-stage reap budgets (**parse 20m** — PPTX measured 603s, so
  today's `processingMaxMin: 45` can kill a healthy job)
- `ingestion-profile.js` seeded with **v1 values only** — proves the config seam at zero delta
- **`DocumentTable` + `DocumentTableRow` → `ROUTED_MODELS`** (§7.3, my defect)
- **`.amr` lexical lane** — new agent endpoint on BOTH duplicated handlers
  (`byod/agent/server.mjs:592`, `core/src/vector/mneme/embedded-agent.mjs:455`) + the
  `byod-http-parity.mjs` fixture. **Promoted to P0:** 54% of tenants have no lexical lane,
  so exact-token questions (`35113`) cannot work for them at all. This is the single largest
  cause of accuracy differing between users.
- Baseline capture on an empty org, current code, per format
- **Gate:** canary 6/6; counts identical to today; an `.amr` table write lands in the
  tenant store.

## P1 — Evidence-first recall. ✅ LIVE (`sha-af83f6c5c`)
Depth/deliver split · lexical merge · scope symmetry · one `deliverHybrid` · lane ungated ·
`expand_evidence` includes `fact` · interleave fallback · committed canary.
**Not in the original P1 scope, found in production:** the `hop2Evidence` gate and
`expand_evidence`. Recorded so the next plan doesn't assume a written plan is complete.

## P2 — Ingestion yield. Write-side, additive.
`DOC_CAP = ceil(chars/550)` · **delete `MIN_IMPORTANCE`** · **delete the curator's 70% cap**
· window overlap 0→200 · `entityContext` + heading_path + page + doc summary into the window
(**both** null sites) · offset-based `segmentId` · **kill `chunkWithDocling`**.
**Gate:** reference deck 16 → ~115 memories, all German;
`windows_processed == windows_total` logged for every document, or an explicit
`budget_exhausted` line. No silent tail-drop, ever.

## P3 — Atomic facts + section-tree segmentation. Transformative.
Atomic prompt (one subject-prefixed attribute, ~10–20 tokens) · windows = N contiguous
segments inside ONE section · populate all segment metadata (zero migration, §4.1).
**Gate:** median tokens/fact 10–20; `segment_type != 'structured'` and `heading_path`
non-null on a sampled 20; supersession key well-defined.

## P4 — Entities + relations.
Deterministic resolver with alias guards · 5b intra-document relation pass · partial unique
index on `is_latest` · `Entity` → `ROUTED_MODELS` **(owner decision)** · table grounding
keys (§4.3 T1, migration + down).
**Gate:** `hannover` → exactly ONE canonical row, mentions > 0; every `Derives` has
`inferred=true` and appears in no citation.

## P5 — Frontend. Must not break, must not fork.
Stage display per the mapping in §9.1 · `enrichment` as its own non-blocking state so a
zero-memory document reads as an **outcome** not Failed · ONE batch poller
(`/documents/processing`) replacing N per-job pollers — this is the fix for list churn ·
"Clear completed" · precheck `"maybe"` handling · **feature-detect the backend** (FE and
core deploy separately and have raced).
**Gate:** browser, all three live orgs including the 0-memory one. A green curl is not e2e.

## P6 — API surface.
`customId` + the idempotency matrix · `taskType` · `filterByMetadata` · `dreaming` ·
scope-aware precheck. **Verify first** whether the FE reaches upload on core `:2026` with a
scoped key or via control-plane `:2027` with a session Bearer — unverified. Quota
(`planEnforcer.checkLimit`) lives in **core**, so P0–P4 are expected to need no
control-plane change.

## P7 — Delete the v1 branches and the flags.
Not optional. A flag still present in three months **is** the second path we said we
wouldn't leave.

---

# PART 11 — VERIFICATION DOCTRINE

Earned the hard way this session — four production deploys spent fixing gates downstream
of the actual cut.

1. **Assert the mechanism, not only the outcome.** `recall-detail-canary.sh` fails on
   `ev_in=0` **even when all five answers pass**. Each of the three gates passed one check
   and failed the other; that is precisely why they hid.
2. **Never `return []` silently.** Every empty result carries a reason, and the reason is
   logged unconditionally. One counter ended three turns of speculation.
3. **Trace inward from the observable**, don't reason outward from where you last looked.
   Four greps would have done what four builds didn't.
4. **Check the live env against the code default.** `KB_CURATED_MEMORY_CAP=8` and
   `KB_FACTS_PER_1K_CHARS=6` both overrode the code while I blamed the algorithm.
5. **Verify markers INSIDE the image**, not in the Dockerfile — a cached `base` layer once
   hid a missing ImageMagick.
6. **Your own probe is the first suspect.** This session: a synthetic `userId` returning 0
   rows, `websearch_to_tsquery` ANDing German stopwords, and a lexical ground truth that
   scored the reranker's *correct* `Wallbox`/`Charging station` answers as misses.
7. **Semantic ground truth, never a lexical proxy** — over a bilingual corpus a proxy
   certifies regressions as green.
8. **Two scoped keys + set intersection** for any new tenant-visible surface. Never
   inferred from reading a `WHERE`.

---

# PART 12 — OPEN ITEMS

| item | impact | blocked on |
|---|---|---|
| `.amr` has NO lexical lane | 54% of tenants can't answer exact-token questions | agent-side endpoint ×2 + fixture |
| `.amr` evidence is org-wide cross-user | one user's personal upload visible org-wide | same |
| `DocumentTable` not routed | 7 orgs' spreadsheet cells written centrally | P0, my defect |
| `Entity` not routed | split-brain entity resolution on `.amr` | **owner decision** |
| 21 of 100 docs have no `scope-key` | owner-only until backfilled | P0 backfill |
| **0 documents anywhere have `scope-key:organization`** | team knowledge doesn't work by construction | upload-scope decision |
| planner rewrites the query before recall | non-determinism; rewrite seen truncated mid-word | pass verbatim to the evidence lane |
| ~65 legacy documents unrecoverable | no re-extract endpoint | source retention is new-uploads-only |
| this document + the rollout plan are UNTRACKED | one dirty working tree away from loss | commit to `singulance-main` |
