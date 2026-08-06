# `.amr` engine — session journal, 2026-08-05/06

What was built, what was measured, what broke, and what is deliberately still open.
Every claim here was verified against the live box; where something is unproven it says so.

Companion to [`amr_selfcontained_plan.md`](./amr_selfcontained_plan.md) (the plan this
executes) and [`kb_durability_plan.md`](./kb_durability_plan.md).

Baseline at start: `hm-core` on `sha-c2a1f32`. End: `sha-47d0122`.

---

## 0. The reframe that made the hard part shippable

The plan called Phase C ("in-shard BM25 + stemming, to match Postgres `ts_rank`") **weeks
of Rust core work**, and it was the blocker for a self-sufficient slot.

The owner reframed it: *the shard does not need to rank — it needs to return a WIDE
candidate pool (150 wide / 40 deep) and the existing cross-encoder rerank + fusion do the
scoring.* That is a different, much smaller problem: optimise **recall**, not precision.

That single reframe turned the long pole into a verified change in one session. Recorded
here because it generalises: before building a component to match another system's
quality, check what the pipeline downstream of it actually needs.

---

## 1. Shipped + verified in production

| Commit | Change | Evidence |
|---|---|---|
| `2959867e` | Phase A: shard snapshot + compaction scheduler | 7/7 slots snapped; **restore drill**: snapshot opened with the real engine → 38/38 memories, 112 relationships, lexical works |
| `c615e4a3` | Sparse-aware snapshots | `shard.vec` measured 4,194,304 apparent / **167,936 allocated**; `copyFileSync` filled the holes → 35 MB/pass. Now **2.08 MB/pass** |
| `419324b9` | Compaction made deterministic | Fired **0 times in an hour**; now `attempted=2 compacted=2 reclaimed=1.83 MB` |
| `449d9f25` | SQL-mirror backfill | **6 of 7** `amr_embedded` orgs had ZERO mirror rows → 74 inserted, 0 failed |
| `6d0636ed` | B5: graph-expansion + update-chain for `.amr` | Real memory returns **8 out + 2 in** edges; central path returned 0 |
| `7dd0e9e9` | B4 step 1: evidence dual-write into the shard | Reads untouched; shard accumulating evidence for read-compare |
| `45215e66` | Mirror backfill must skip non-memory layers | Self-inflicted bug, caught pre-impact (see §3) |
| `47d0122f` | **In-shard lexical lane** + wider vector over-fetch | `warrant` → finds `Warranty` on live data; `solvis` → 25 candidates; `zzzznotaword` → 0 |
| `687cb12c`, `f0538d2f` | ICARUS sync script + open-source docs | Published to ICARUS `1f9038e` |

### The defect that mattered most

`/v1/lexical` — the lexical half of hybrid recall for `.amr` tenants — runs **Postgres FTS
over the `memories` mirror**, not over the shard. `/v1/write` mirrors each new record, but
memories written before that mirror existed were never backfilled.

Measured: 7 orgs `amr_embedded`, **only one** had mirror rows, while shards held real data
(38 / 24 / 12 memories). Those tenants were silently running **vector-only recall** — no
error, no log, just half the hybrid missing. Same silent-partial shape as the Qdrant
embedding drift the embed-reconciler exists for.

After backfill: `solvis` returns **16 hits** where lexical previously returned nothing.

### The in-shard lexical lane (the Phase-C substitute)

`amr.lexical()` was a pure substring scan over raw text and missed exactly what matters in
a German corpus. Three cheap, **language-neutral** rules — no stemmer, no per-language word
lists (the brittle thing this codebase keeps deleting):

1. **fold** — lowercase, expand umlauts (`ä→ae`, `ö→oe`, `ü→ue`, `ß→ss`), strip remaining
   diacritics + punctuation. `Art.-Nr.` → `['art','nr']`.
2. **prefix** — either token is a prefix of the other (≥3 chars). One rule catches BOTH
   `art` ⊂ `Artikelnummer` AND the inflections a stemmer would handle.
3. **substring** fallback for compounds.

| case | before | after |
|---|---|---|
| `Artikelnummer` vs `Art.-Nr. 35113` | **0** (measured live) | **0.60** |
| `Ladesäulen` vs `Ladesäule` | miss | 0.60 |
| `Teillast` vs `Teillastbetrieb` | miss | 0.60 |
| `Grundstück` vs `Grundstueck` | miss | 1.00 |
| unrelated text | — | **0.00** (no false positive) |

Live confirmation on the running agent: `warrant` (stem) → 1 hit on `Warranty`;
`Wartung` → 0, and the corpus genuinely contains zero occurrences (a correct zero, not a miss).

Wired as a **UNION after** the Postgres lane, not a cutover: Postgres stays first because it
is better ranked, the shard tops up the pool and needs no mirror. Strictly additive — dedup
by id, never drops a Postgres hit.

**Vector width**: the over-fetch was hard-capped at 200, so a 150-wide request (`RERANK_POOL`
is 150) could come back short once `_passesFilter` dropped candidates — starving the
cross-encoder of the pool it exists to rank. Now scales with the request, capped at
`MNEME_RECALL_OVERFETCH_MAX` (1000).

---

## 2. Where an `.amr` slot stands now

| Lane | Served from |
|---|---|
| memory vector | **shard** (`shard.vec`, HNSW/brute-force) |
| memory lexical | Postgres FTS **+ shard union** (shard alone suffices when the mirror is thin) |
| graph / 2-hop / update-chain | **shard** (`shard.edg`) |
| evidence vector + lexical | Postgres + Qdrant (**shard dual-write accumulating**) |
| entities | central Postgres |

A slot answers **vector + lexical + graph from its own file**; Postgres is now a ranking
assist rather than a hard dependency for memories.

---

## 3. Mistakes made, and what caught them

Recorded because the pattern matters more than any single item.

1. **I introduced an interaction bug between two changes shipped minutes apart.**
   `backfillSqlMirror` streams EVERY shard record into `memories`; the evidence dual-write
   then started putting evidence records in that same shard. The next hourly backfill would
   have filed **evidence segments as memories**, and since `/v1/lexical` reads that table
   they would have surfaced in recall as first-class memories. Caught before it ran
   (`hm.memories` still 290 rows, all `layer='memory'`, zero backfill passes since the
   dual-write). Fixed by filtering to `layer='memory'`. Found only because I went to verify
   the dual-write rather than trusting the green deploy.
2. **A deploy silently failed and I reported it as in progress.** `release-lock REFUSING:
   only 21GB free (< 25GB)`, `EXIT=1`. The fix was not live. Verification caught it.
3. **I proposed a gitlink bump backwards.** Claimed `9d1ec5f` was newer than `d9fbb83`;
   `merge-base --is-ancestor` proved the opposite — `d9fbb83` **contains** `9d1ec5f`, so the
   bump would have reverted the FE API-docs commit. Rule: ancestry check before any gitlink move.
4. **I deployed the FE from a stale branch** (`release/kb-final`, Aug-1) and regressed the UI
   by three days. Fixed by rebuilding from `main` (`f432620`).
5. **`COPYFILE_FICLONE` was the wrong fix** for sparse copies — it only helps on CoW
   filesystems and the box is ext4, where it throws. Tested, rejected, replaced with
   `cp --sparse=always`.

---

## 4. Deliberately NOT done (and why)

- **Evidence lexical union.** Evidence access is gated by the document join
  (`appendDocumentAccess`, scope-key tags on `knowledge_documents`). The shard record does
  not yet carry that scope reliably, so unioning shard evidence would **bypass the access
  check and leak segments across scopes**. Left on Postgres rather than ship a quiet
  data-exposure path. Unblocked by the access-control port (§5).
- **B4 steps 2–3** — read-compare on real embeddings, then flipping `/v1/kb-recall` to the
  shard. Dual-write is live so the comparison data is accumulating.
- **B7/B8** — entities into the shard, then retiring the mirrors. Gated on the above.
- **A3/A4/A5/A7** — Python binding, reproducible public benchmark, framework integrations,
  PQC enforce-mode/BYOK. Each multi-day; a benchmark that is not reproducible damages the
  claim it exists to prove.

---

## 5. Operational hazards found (need an owner decision)

1. **Disk is the recurring blocker.** The box went 52 GB → 21 GB free in a day of releases and
   a deploy silently refused twice. `/root/releases/` holds **19 worktrees × 432 MB ≈ 8 GB**
   with no retention policy, plus per-SHA images. Not pruned here because they back rollbacks.
   Safe reclaim order: `docker image prune -f` (dangling only) → `docker builder prune -f`.
   **Never `image prune -a`** — it deletes other sessions' `sha-*` rollback tags.
2. **An uncommitted, hardcoded `image:` line in `infra/docker-compose.hetzner.yml`** means a
   plain `docker compose up` silently reverts whatever was just released. Observed: a release
   verified healthy at 16:48, reverted at 16:49:26 by a parallel session's compose up.
3. **`deploy-singulance-cloud.sh` reports success too easily.** A `rev`-label mismatch appends
   a `✗` but does **not** set `FAIL`, and the wrapper prints the *expected* image name rather
   than the container's actual one — that is how `RELEASE OK — c615e4a` printed while
   `cca081064` was running.

---

## 6. Invariants for the next session

- The shard is a **candidate generator**; ranking belongs to the reranker. Do not rebuild
  `ts_rank` in Rust.
- Snapshot before compaction, always — compaction rewrites data.
- Additive first: dual-write → read-compare on real embeddings → cutover. Never a blind flip.
- Access control is not optional for evidence. A shard-side read path must reproduce
  `appendDocumentAccess`, or reuse it, before it serves a single segment.
- Verify in the running container, not from deploy output. `RELEASE OK` has lied twice.
