# KB Ingestion — Session Decision Record, 2026-08-04

Everything decided, built, broken and reverted in the KB upload/ingestion path in this
session. Companion to `ingestion_v5.md` (the architecture this sits inside — **unchanged**,
see §9). Live at the time of writing: `hivemind/core-api:sha-70c665565`,
`singulance-main` @ `70c66556`.

Written to be usable cold. Every number here was measured on this box; nothing is
inferred. Where I got something wrong, the wrong version is kept alongside the fix,
because several of these defects were *caused* by a previous plausible-looking fix.

---

## 1. Files responsible

| file | role in ingestion |
|---|---|
| `core/src/knowledge/document-first-ingestion.js` | The heart. Envelope ingest (`ingestSource`), windowing, the unified extract, curation, persistence, claim structuring, entity hand-off. ~4300 lines; nearly every change below is here. |
| `core/src/knowledge/normalize.js` | **NEW this session's lineage** — the one seam every format passes through: `normalize(buffer,{mime,filename}) → {ok,markdown,text,tier,meta}`. Contract: markdown-or-null, binary FAILS. |
| `core/tests/unit/normalize-contract.test.mjs` | 12 fixtures pinning that contract (incl. a ZIP container must return `ok:false`). |
| `core/src/knowledge/document-chunker.js` | `parseFile` — now delegates to the seam; its own pdf/docx/csv extraction and catch-all `buffer.toString('utf-8')` deleted. |
| `core/src/knowledge/enterprise/groq-vision-parser.js` | Vision OCR tier. PDF→PNG rasterisation lives here. |
| `core/src/knowledge/enterprise/docling-adapter.js` | Docling client. Emits `hybridChunks[]` each carrying `headings: string[]` (line ~302). |
| `core/src/knowledge/enterprise/litellm-client.js` | `chatCompletion` / `chatCompletionWithFallback`, provider pinning, truncation salvage. |
| `core/src/memory/canonical-entity-persister.js` | `persistCanonicalLinks` — canonical entity registry, reuse prepass, `normalizeEntityKind`. |
| `core/src/memory/entity-resolver.js` | Fuzzy/exact entity identity resolution (`AUTO_LINK_FLOOR` 0.95). |
| `core/src/memory/prisma-graph-store.js` | The universal chokepoint — `createMemory` stamps `claim_key` / `claim_subject` / timestamps. |
| `core/src/server.js` | Upload routes + the format tier chain (`FORMAT_PROFILES`, `sheet-direct`, `csv-direct`, `fast-pdf`, seam routing). |
| `core/src/vector/mneme/embedded-agent.mjs` | In-process `.amr` agent for `amr_embedded` orgs — 35 endpoints, shard open, SQL mirror. |
| `core/src/vector/mneme/remote-backend.js` | Central→agent HTTP client (`remoteList`, `remoteStats`, …). |
| `core/src/vector/mneme/amr-store.mjs` | The `.amr` engine wrapper: `recall`, `lexical`, `hydrate`, `graph`, `flush`. Native binding `singulance-amr.linux-x64-gnu.node`. |
| `.env` (`/root/hivemind/.env`) | **The live authority.** Overrides every code default below. Read it before reasoning about any tunable. |

---

## 2. What was wrong, what was done, and what it cost

### D1 — Vision render died on real PDFs
**Symptom.** `[docling-adapter] groq-vision failed: Render failed: … convert-im6.q16: cache
resources exhausted @ error/cache.c/OpenPixelCache/4124` on a 32-page 16 MB upload
(`AI_Report_2025.pdf`). The document still succeeded because a lower tier caught it — so its
**figure content was silently lost** and nothing surfaced to the user.

**Cause.** `convert -density 150 whole.pdf page-%03d.png` rasterises the *entire* document
through one ImageMagick pixel cache. IM's own ceilings on this box: `Memory 256MiB`,
`Disk 1GiB`, `Area 128MP` (`identify -list resource`).

**Decision.** Rasterise with poppler `pdftoppm`, which streams **one page at a time** with
bounded memory regardless of document size. ImageMagick stays as a fallback with raised
`-limit`s. Also `-l MAX_PAGES` so we stop rendering pages we were about to slice away.

**Alternative rejected:** raising the IM limits. It only moves the cliff to a slightly larger
file; the algorithm is wrong, not the ceiling.

**Evidence (reproduced, not assumed).** Same 11-page PDF at density 600:
`convert` produced **2 of 11** pages then died with the identical error; `pdftoppm` produced
**11 of 11**.

**File.** `groq-vision-parser.js`.

### D2 — The render blocked the event loop, which lost job locks
**Symptom.** Four `[kb-queue] worker error: could not renew lock for job …` in the same batch
as D1.

**Cause.** `execFileSync` holds the event loop for the whole render — up to the 180 s timeout —
so the worker cannot answer anything meanwhile, **including BullMQ's lock renewal**. A lost
lock means the job is treated as stalled and **re-run**: a blocking render did not merely delay
work, it duplicated it.

**Decision.** `await execFileAsync` for both rasteriser calls. Only this file used sync exec in
the ingestion path (verified by grep).

**File.** `groq-vision-parser.js`.

### D3 — `parse_engine` lied about which tier ran
**Symptom.** Four uploads logged `tier=fast-pdf`; every DB row recorded
`parse_engine='docling'`.

**Cause.** `_parseDocument` hardcoded `engine: parseOk ? 'docling' : 'docling-chunks-only'`,
overwriting the adapter's own label. The adapter emits at least eight: `plain-text`,
`groq-image`, `sheet-direct`, `csv-direct`, `groq-vision`, `pdf-parse`,
`docling-fallback-vision`, `docling-fallback-fastpdf`, `seam:*`.

**Cost.** "Which path produced this document?" was unanswerable from the data, and it
**corrupted a measurement I then reported**: the "55 of 61 docling documents carry no
heading_path" figure was mostly fast-pdf.

**Decision.** Report `doclingResult.engine`; chunks-only is a property of *this* layer so it
suffixes whatever the adapter said.

**File.** `document-first-ingestion.js` `_parseDocument`.

### D4 — `docling-chunks-only` discarded headings we already had
**Symptom.** All 26 `docling-chunks-only` documents (11 pdf / 8 docx / 5 xlsx / 2 pptx) had
**zero** `heading_path`, so their citations could only ever say "page 3".

**Cause.** Chunks-only means docling's *parser* failed while its *chunker* succeeded. That path
joined bare `chunk.text` and set `markdown: null` — yet every chunk carries `headings: string[]`
(`docling-adapter.js:302`), which we already fetched and threw away.

**Decision.** `markdownFromHeadedChunks(chunks)` rebuilds markdown from those headings,
re-emitting descendants when an ancestor changes so a child reusing a name under a new parent
("Preise" under a second chapter) cannot inherit the wrong path. Same contract as the seam:
markdown or **null**, never flat text aliased as markdown. 8/8 unit cases.

### D5 — Markdown was being re-parsed by docling
**Cause.** `KB_SEAM_FORMATS` defaulted to `docx,html,htm`, so `.md`/`.txt` went to docling —
which re-parses markdown and discards the `#` headings it arrived with. Measured: 14 `.md` and
5 `.txt` took that path.

**Decision.** Default `docx,html,htm,md,markdown,txt,text`. The seam returns markdown only when
real headings exist, so nothing gains structure it did not have. CSV left on its existing tier.

**File.** `server.js` seam routing.

### D6 — Model swap: gpt-oss → deepseek, and the two budgets it invalidated
**Symptom (before).** `[enterprise-extract] model=openai/gpt-oss-20b … finish=error` then
`Failed to parse JSON response`, repeatedly. Its only configured fallback was
gpt-oss-**120b** — the same family — so the retry inherited the same weakness. A fallback chain
of two variants of one model is not a fallback chain.

**Decision.** `deepseek/deepseek-v4-flash-0731` for the small JSON-shaped calls. **Pinned**, not
the floating `~deepseek/deepseek-v4-flash-latest` alias. $0.09/$0.18 per M (cheaper than
gpt-oss-120b), 1 M context.

**MY REGRESSION.** deepseek emits far more tokens than gpt-oss for the same task, so budgets
tuned to gpt-oss became **guaranteed truncations**:
- `v5-claim-structuring` at `max_tokens: 800` → **every** call returned
  `completion=800 finish=length`, JSON never parseable, always fell through to gpt-oss-120b.
  **12 truncations to 2 clean stops (86%)** in one document. Strictly *worse* than before the
  swap: two LLM calls per claim for the same output.
- `kb-document-type` at `max_tokens: 256` — same shape, caught before it shipped.

**The lesson.** `finish=length` raises no error; it returns unparseable JSON. The failure
surfaces as a fallback storm and doubled latency, never as an exception. **Swapping a model
silently invalidates every `max_tokens` sized for the old one.** This is what D10 exists to
prevent structurally.

### D7 — `DOC_CAP` gated reading as well as output → silent data loss
**Symptom.** `TAIL DROPPED: 1 of 6 windows never sent to the LLM (budget 30 exhausted)` on a
12 175-char document. Facts in that window existed in **no layer** and were unrecoverable
without a re-ingest, because nothing recorded *which* window was skipped.

**Cause.** One variable did two jobs: `DOC_CAP` bounded output facts *and* gated the read loop
(`while (wi < len && uBudget > 0)`).

**First fix (mine, incomplete).** Floor the shared budget at `windows × MIN_FACTS_PER_WINDOW`
so it cannot reach zero. Correct outcome; left one variable owning both concerns, so the next
person tuning the cap would re-break reading.

**Final decision.** Split them:
- `readAllWindows` — every window is sent, **always**. Not a budget, not negotiable.
- `factBudget` — how many facts we *ask* for; a window short on budget still gets
  `MIN_FACTS_PER_WINDOW` (3) so it is read and can contribute.

**Stated trade:** total facts may exceed `FACT_CAP` by at most `windows × MIN` — deliberate, in
exchange for never silently discarding part of a document. The old `TAIL DROPPED` warning is now
an **INVARIANT VIOLATED** error that can only fire if someone re-gates the read loop.

### D8 — Language drift: measured, NOT fixed
**Symptom.** German source, English memories: *"Phase 1 starts in April 2026 with the pilot
installation in Hanover"* from *"Phase 1 startet im April 2026 mit der Pilotinstallation in
Hannover"*. Hannover even anglicised.

**Attribution corrected.** I blamed the deepseek swap. **Wrong** — facts come from
`KB_UNIFIED_MODEL` (gemini-2.5-flash-lite), and MANDI rows from 2026-07-22 show the same mix
("Aggressive Wettbewerber" preserved, "Launch Solvis PIA on 18 August 2026" translated). It
long predates any model change; `ingestion_v5.md` guarded against language-specific *code*, not
a language-*destroying* model.

**MY WORST REGRESSION OF THE SESSION.** I added to the prompt: *"every `t` you emit must be
readable as a sentence lifted from the SECTION itself."* Intended to pin language; reads as
*copy verbatim* and collides with the atomicity rules directly above it. Deployed result on a
real German document: **0 facts from 4 windows**, each holding 30–46 fact-bearing sentences
(`EXTRACTION SHORTFALL: kept 0 facts`, four times, model answering normally with `finish=stop`,
480–694 completion tokens). `candidates=0, memories=0`. Translated memories are still memories;
none at all are nothing. Reverted within minutes, cause recorded in-source so it is not
reintroduced.

**Kept:** the `t`/`f` same-language rule (checkable, since `f` must be a verbatim substring of
the section) and an explicit "do not convert `1.240`→`1,240` or `Hannover`→`Hanover`". Both
constrain *language* without constraining *form*. **That distinction is the lesson.**

**Instrumentation added — `LANGUAGE DRIFT`.** Language-neutral, no detector library, no
per-language word list: a faithful fact shares many tokens with its own source quote; a
translated one shares almost none.
- My first cut kept numerals, scored the real observed pair at **0.50** and **missed it** —
  dates and prices survive translation and inflate overlap. Excluding pure numerals scores it
  **0.40** against **0.75–1.00** for faithful facts. Threshold **0.45**, env
  `KB_LANG_DRIFT_THRESHOLD`, validated on 7 pairs from real output (3 translated / 4 faithful).
- My log then printed `<15%` while applying 0.45 — a log that misreports its own criterion is
  worse than none. Fixed to derive from the variable.
- **Logged, never dropped.** A miscounted fact must not delete a tenant's data.

**Current measurement: ~67% drift** (`4/11, 7/9, 9/10` across windows; 20/30). Open.

### D9 — Claim structuring: 24 calls → 1, with verification
**Finding.** This was the **last per-item LLM fan-out** in ingestion. Everything else is already
1-per-document or 1-per-section-batch — `kb-unified-extract` returns facts **and** entities
together (`document-first-ingestion.js:587`: *"no separate entity-link LLM on facts"*), and
`kb-doc-relations` batches 40 candidate pairs into one call. A 25-memory document therefore
issued ~24 tiny requests: the flood of 500–1000-token calls in every ingest log, and the ones
that truncated at 86% in D6.

**Decision.** One batched call for up to 24 memories, `{"claims":[{i,subject,predicate,qualifiers}]}`,
mapped back by index.

**Owner constraint honoured — "do not compromise quality; if one call produces low quality,
verify and only then generate; sometimes it might get capped out."** Batching would otherwise
trade one silent failure for another: a capped response returns fewer claims than memories.
So:
1. coverage is **verified** against the input;
2. any memory the batch missed is **re-requested individually** (bounded concurrency);
3. if the batch throws, **everything** falls back per-memory.

5/5 cases prove no memory is left unstructured under any batch outcome — complete batch, capped
batch, empty batch, junk indices, empty claims. An out-of-range `i` is **skipped, never
guessed**: writing a claim onto the wrong memory would corrupt supersession, which keys on
(subject, predicate).

**Not folded into extraction, deliberately.** It runs post-commit on the **final** memory text —
after atomic splitting, curation, dedup and prefix stamping. At extract time those memories do
not exist, and one extracted fact can become several. `ingestion_v5.md` put it post-commit for
this reason and that reasoning holds.

### D10 — `LLM_PROFILES`: a model and its budget are ONE decision
**Cause of D6 in one line:** seven independent env vars (`KB_UNIFIED_MODEL`,
`MEMORY_PROCESSOR_MODEL`, `ENTERPRISE_EXTRACTION_MODEL`, `CLAIM_STRUCTURING_MODEL`,
`KB_UNIFIED_FALLBACK_MODELS`, `MEMORY_FAST_MODEL`, `COGNITION_WRITER_MODEL`), each with a
`max_tokens` scattered across the file and tuned to whoever was current when that line was
written.

**Decision.** One `LLM_PROFILES` table + `llmProfile(feature, {batchSize, compact})`. Rules
encoded in it:
- budgets sized for the **most verbose plausible model**, never the current one — headroom is
  free when a model stops on its own; a truncation is a total loss of the call;
- an **unknown feature throws** rather than silently receiving a default budget;
- a fallback chain can no longer list the primary twice.

9/9 cases. `kb-doc-summary` raised 420 → 900 for the same verbosity reason.

### D11 — Typed entities, and the real cause of generic-noun leaks
**Symptom.** `Hauptkomponente` and `Anlage` (German for "main component" / "plant") were stored
as canonical entities. Every canonical row had `entity_kind='entity'`.

**Cause 1 (leaks).** The only gate dropped numeric-led phrases, and **German capitalises every
noun** — so "capitalised = proper noun" is structurally wrong, not merely imprecise.
**Decision:** the prompt now states capitalisation is not evidence and gives a *test* — a
generic KIND of thing vs one specific identifiable thing — with no dictionary and no
per-language rule.

**Cause 2 (flat kinds).** The persister already had a taxonomy and `normalizeEntityKind()`;
ingestion simply never sent a kind. **Decision:** entities may arrive as `string` or `{n,k}`;
the persister keys identities by **(kind, slug)** so one surface form under two kinds is two
identities, and an unknown kind falls back to the call-level namespace rather than minting a new
one.

**The ripple, which is the instructive part.** Changing `durableEntities`' return shape from
strings to pairs broke three consumers that had to be found deliberately:
- the merge used `[...new Set(...)]`, which dedupes **objects by reference** — every merged
  candidate would have contributed a duplicate. Now keyed `kind::name`.
- `entity:*` tags built slugs from the raw element; they now read the **name** whatever the
  shape, so the compatibility tags are byte-identical.
- the curator's input summary would have shown `[object Object]` to the model; it gets names
  only.
- the reuse prepass queried **one** kind, so every typed entity would have missed the cache,
  fallen through to the resolver, scored 0.93 exact (< `AUTO_LINK_FLOOR` 0.95) and landed in the
  review queue — the exact `+0 entities, 0 links, 1 queued for review` failure the earlier
  paging fix was written for. Now `entityKind: { in: _kindsInBatch }`, cache keyed `kind::variant`.

**Verified at the model boundary:** 3/3 entities typed correctly (`organization`, `person`,
`standard`) and `Anlage`/`Wartung` correctly **not** emitted. 6/6 + 7/7 unit cases; untyped
behaviour unchanged.

### D12 — «filename : heading» — three attempts, one real cause
**Requirement (owner).** Every memory subject-headed `«filename : heading»`, with the ingest
date in the text.

**Symptom.** 2/30, then 1/25. The one hit was the summary, stamped on a different path.

**Attempt 1 (wrong layer).** Segments showed 16/16 `heading_path` but only 2/16 `heading`, so I
widened the segment→heading fallback (`segmentHeading()`, taking the deepest `heading_path`
component). Semantically right — `heading` means *this segment is a heading*, `heading_path`
means *this segment lives under these headings* — and it changed **nothing**.

**Attempt 2 (still wrong layer).** The claim never inherited the window's heading, so I copied
`w.heading` onto the claim at `extractedCandidates.push()`. Also changed **nothing**.

**Actual cause.** `normalizeCuratedClaims` **rebuilds every claim from an explicit field list**
between extraction and persistence, and that list omitted `heading`. Nothing upstream could
matter.

**Result after fixing the rebuild: 2/20 → 14/20 on a real upload.**

**The lesson, which caught me twice in one session:** when a value fails to arrive, find the one
place that **rebuilds** the object — not the places that read it.

### D13 — `.amr` shard "locked by another process" was hm-core fighting itself
**Symptom.** `[mneme/remote] list failed org=…: shard is locked by another process` on 5 of 7
embedded orgs, always in a burst, always the same orgs.

**Cause.** `fuser` showed a **single PID holding every `shard.lock`**, and its parent was
hm-core's own main PID — there is no other process. The lock is per-**open**, not per-process.
`getCtx` checked its cache, then `await`ed `ensureSchema()` and `ensureQdrant()` **before**
constructing the store and populating the cache, so two concurrent callers for one org both
missed the cache and both opened the shard. The startup sweep fans stats/list across every org
at once — hence the burst.

**Disproved first theory (mine):** LRU eviction leaking locks. `MAX_OPEN` is 64 with 13 orgs, so
nothing is ever evicted.

**Decision.** Single-flight: memoise the in-flight **promise**, cleared on failure too so one
transient collision cannot make an org permanently unreadable. 4/4 cases.

**Verified live:** 12 concurrent requests → **exactly 1 shard open, 0 lock errors**, all 200s.

### D14 — A failed read returned an empty list
**Cause.** `remoteList` caught everything and returned `{ memories: [], cursor: null }`. A
transient shard-lock collision therefore rendered a tenant's Memories page **empty** — visually
identical to owning no memories, separable only by a console warning. Same defect shape as a
document logged `indexed` with zero memories, or `200 []` from a broken dependency.

**Decision.** It throws. Then callers were split **deliberately**, because changing a return
contract breaks callers silently:
- user-facing reads (`prisma-graph-store.js:808,840`) propagate — a page must say it failed;
- background jobs (`profile-dreamer` ×2, `cognition-loop`) opt into tolerance with a logged
  `.catch`. A background dream degrading is correct; a page lying is not.

---

## 3. The model decision

Split by task, not one winner. Measured on the same German document **after** the truncation and
batching fixes, so the comparison is not confounded by them:

| `KB_UNIFIED_MODEL` | extract | language drift |
|---|---|---|
| `google/gemini-2.5-flash-lite` | **4.3 s** | 20/30 (67%) |
| `deepseek/deepseek-v4-flash-0731` | 291.6 s | 17/22 (77%) |

DeepSeek is ~68× slower **and** drifts more, so there is no quality argument to offset the
latency. An earlier "DeepSeek is better on language" reading (46%) came from a small sample and
did not hold.

**Live config:**
```
KB_UNIFIED_MODEL=google/gemini-2.5-flash-lite               # fact extraction
MEMORY_PROCESSOR_MODEL=deepseek/deepseek-v4-flash-0731      # small JSON calls
ENTERPRISE_EXTRACTION_MODEL=deepseek/deepseek-v4-flash-0731
KB_UNIFIED_FALLBACK_MODELS=deepseek/deepseek-v4-flash-0731,openai/gpt-oss-120b  # two FAMILIES
COGNITION_WRITER_MODEL=openai/gpt-oss-120b                  # untouched, out of scope
```
Both measurements are written into `.env` above the line so the next person who considers
flipping it sees why not.

---

## 4. Performance, before and after

Same org (`6946c8a6`, `amr_embedded`), same document shape:

| stage | before | after |
|---|---|---|
| `extract` | 118 173 ms | **4 335–4 447 ms** |
| `promote` | 134 118 ms | **11 807–13 518 ms** |
| windows | `TAIL DROPPED 1 of 6` | **4/4 processed, 0 dropped** |
| claim-structuring calls | up to 24 | **1** (+ backfill only if capped) |
| byte upload (client-visible) | — | **80 ms** (`202`, then async) |

`parse` (3–12 s) is now the slowest stage.

---

## 5. Storage modes

| mode | orgs | documents ingested |
|---|---|---|
| `hybrid` | 6 | 47 (central `hivemind` schema) |
| `amr_embedded` | 7 | 26 (`hm` schema) — verified end-to-end this session |
| `byod_amr` | 1 | **0 — never exercised** |

Ingestion runs in **core** for all three (identical metadata, `document-first-ingestion.js:3146`),
which is why every fix above propagated to all modes at once. Only where segments and memories
land differs. The byod agent is in parity (`check-byod-sync.sh`: 22 files) and is
single-tenant, so D13's race cannot occur there.

**Discrepancy to resolve:** org `0a1d5b33` is labelled `memory_storage_mode=byod_amr` but its
agent boots `store=pg-qdrant` — the label and the runtime disagree.

---

## 6. Is `.amr` standalone for lexical?

**As an engine, yes.** `amr-store.mjs` has its own `lexical()` (token-overlap scan over shard
records), `recall()` (own vector index), `hydrate`, `graph`, `stats`. No SQL.

**As deployed, no — deliberately.** Both lexical lanes route through Postgres.
`embedded-agent.mjs:578` records why: *"This used to be `amr.lexical()` … so the two .amr modes
ranked text differently from each other AND from hybrid, with no justification."* Postgres also
buys filters the shard index cannot express: `layer`, `must_not.layer`, `known_at`, `valid_at`.
And the shard's `lexical()` is a full scan with substring matching — no index, no stemming.

The SQL mirror that makes this work **is** populated: 33/33 memories and 31/31 segments carry
`content_tsv` for the test org.

---

## 7. My mistakes, collected

Kept together because the pattern matters more than any single item.

1. **Fixed the same bug in the wrong layer twice** (D12). Widened a fallback, then copied a
   field, when the object was being *rebuilt* downstream.
2. **Broke extraction entirely with a prompt tweak** (D8) — 0 facts from 4 windows, deployed.
   Constraining *form* where I meant to constrain *language*.
3. **Shipped a model swap without re-checking token budgets** (D6) — 86% truncation, two calls
   per claim instead of one.
4. **Built an instrument that missed the case it was built for** (D8) — kept numerals, scored
   the real pair 0.50, missed it. Re-tested rather than shipping it.
5. **Wrote a log that misreported its own threshold** (D8) — printed 15% while applying 45%.
6. **Put a contract change on the path that does not run** (D11) — edited `_batchExtractFacts`,
   which is additionally locked to strings by a strict `json_schema`
   (`entities: { items: { type: 'string' } }`, `additionalProperties: false`), so constrained
   decoding made the requested shape impossible.
7. **Claimed a defect that did not exist**: "5/30 memories missing prefix + timestamp" — those 3
   were `tara-skill` internal rows holding JSON skill definitions, which correctly have no
   filename prefix.
8. **Reported "all documents have 0 memories"** from a query using the wrong tag convention;
   via `memory_evidence_links` they had 3–22 each. And a "0 memories" document was simply
   **mid-promotion** — it finished with 21.
9. **Deployed a corrupt image and nearly missed it.** The final build reused a stale
   `COPY core/src ./src` layer: **53 files in `src/memory` instead of 61**, missing
   `canonical-entity-persister.js` entirely. My marker-greps passed because grepping a *missing*
   file returns nothing and I read that as nothing-to-report. Rolled back to the known-good
   build, rebuilt `--no-cache`, and **now verify by file count as well as markers**.
10. **Trusted a comparison built on absent data** — concluded checks "pass on the base" when the
    base had run **zero** checks.

---

## 8. Verification method that actually worked

- **In-image marker greps** *plus* **`ls | wc -l` file count** (mistake 9).
- **Reproduce the failure first**, then fix: D1's `convert` 2/11 vs `pdftoppm` 11/11.
- **Force the race** rather than observing its absence: 12 concurrent requests for D13.
- **`docker exec … node --input-type=module`** to import the real module with real deps —
  `node --check` cannot catch an out-of-scope identifier or a missing file.
- **Live env before code**: `docker exec hm-core env` — `.env` overrode every default in D6/D10.
- **My own probe is the first suspect**: a wrong Qdrant client factory returned 0 segments; a
  broken poll loop made a finished ingest look like a 10-minute hang.

---

## 9. `ingestion_v5.md` — still the architecture

Verified present and load-bearing: `ingestSource` envelope, all three modes
(`document`/`atomic`/`evidence`), `persistCanonicalLinks`, `_structureClaimsAsync`,
`_pureInsert`, the `createMemory` chokepoint stamping `claim_key`, `V5_TYPE_AWARE_RECALL=true`,
and FE endpoint stability (no route added or changed).

Nothing was rebuilt. `document-first-ingestion.js` was **modified, never replaced**. This
session was defect repair inside V5 plus one legitimate new seam (`normalize.js`) — and the
removal of four accreted seams (D7, D10, D11, D12) that had drifted from V5's own principles.

The two residuals V5 listed are still open: **`.amr`/BYOD parity** (byod = 0 documents, exactly
as predicted) and **language-neutral behaviour** (now measured at 67%, where V5 guarded against
language-specific code but not a language-destroying model).

---

## 10. Open items

| item | status |
|---|---|
| **Language drift ~67%** | Measured every ingest; unfixed. Both candidate models fail. Needs a third model tested against the counter, or a post-extraction repair. |
| **`byod_amr` e2e** | 0 documents ever. Needs a scoped key for `0a1d5b33`, which cannot be minted from here (keys are hashed). |
| **`entity_kind` DB round-trip** | Verified at the model boundary; the write to `canonical_entities` needs one upload, blocked by the free-plan cap (see below). |
| **`byod_amr` label vs `pg-qdrant` runtime** | Decide which is intended. |
| **`kb-relations` proposes 0** | All edges come from the hybrid pass; the direct proposer contributes nothing. |
| **`v5-claim-structuring` logs via `logger.info`** | Does not reach container stdout, so the batch runs unobservably. Move to the same channel as the other counters. |
| **`parse` 3–12 s** | Now the slowest stage. |
| **Free-plan cap** | `plan_limit_exceeded — Free plan: 10 uploads/month, current: 11` on the test org. **This is a feature working**: it answers a standing question — the quota *is* enforced on the consuming path, not merely defined. |
| **`heading` granularity** | The prefix now resolves to the document H1 rather than the section H2 for body windows. Correct and non-empty, but coarser than ideal. |

---

## 11. Invariants for the next session

- **Modify existing code.** Every defect above was a wrong default, a dropped field, an
  unimplemented comment or a `||` in the wrong order — not missing code.
- **When a value doesn't arrive, find what rebuilds the object**, not what reads it.
- **A model swap invalidates every token budget sized for the old model.** `finish=length`
  raises no error.
- **Constrain language, never form**, in an extraction prompt.
- **Never turn a failed read into an empty result.** Throw; let background callers opt into
  tolerance explicitly.
- **Verify builds by file count, not only by grep.** A missing file passes every grep.
- **`.env` beats code defaults.** Read it first, always.
