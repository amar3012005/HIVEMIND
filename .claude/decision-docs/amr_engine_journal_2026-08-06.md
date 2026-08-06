# `.amr` engine — session journal, 2026-08-06

Continues [`amr_engine_journal_2026-08-05.md`](./amr_engine_journal_2026-08-05.md).
Goal for the session: keep upgrading safely toward retiring the central Postgres +
Qdrant dependency for the personal `.amr` memory engine, and make the open-source
repo worth publishing.

Baseline at start: `hm-core` on `sha-980d9ec`. End: `prod-20260806-ff7dc7ef2126`.

---

## 0. The headline: yesterday's B4 step 3 shipped a guaranteed crash

`/v1/kb-recall` — evidence recall for every `.amr`/BYOD org — threw
`ReferenceError: j is not defined` on **every recall that found anything**.

The handler fans out over two lanes and collected candidate ids into an array. The return
then rebuilt the result by mapping over **lane A's response variable** to recover scores:

```js
try { const j = await qr.json(); ... }      // j is block-scoped to HERE
...
return { results: (j.result || []).map(...) };   // ...and read from HERE
```

Not a subtle bug — a hard, deterministic break of the feature that was just shipped as
"live". It survived because of three compounding gaps, all now closed:

1. **`node --check` accepts it.** The syntax is valid; only scope analysis catches it.
2. **The repo does no scope analysis.** `"lint": "eslint src/**/*.ts || echo 'No ESLint
   configured'"` — a no-op that globs `.ts` in a `.js`/`.mjs` codebase.
3. **No `.amr` org had run a KB recall in 48 h**, so no log ever showed it. Latency of
   discovery, not absence of the bug.

Yesterday's journal recorded, under B4 step 3: *"Not verified end-to-end: an authenticated
`/v1/kb-recall` call through the live route."* The bug was living in exactly the gap that
sentence names. **Writing down that something is unverified is not a substitute for
verifying it** — the note correctly identified the risk and then the risk happened anyway.

**Fix** (`0a677a89`): carry `{id -> score}` in one insertion-ordered Map across both lanes
and emit from that merged set. Also removes an O(n²) `includes` dedupe.

**Structural fix**: the merge/emit step moved out of the closure into
`kb-hit-merge.mjs` — pure, no imports, no native binding — so it can be unit-tested at all.
Four tests, and the old shape provably throws against them. The invariant it now encodes:
*emitting must read from the MERGED candidate set, never one lane's raw response.* Under
the old shape a shard-only candidate could never be emitted even if the crash were fixed.

---

## 1. Shipped + verified

| Commit | Change | Evidence |
|---|---|---|
| `0a677a89` | kb-recall ReferenceError fix + pure merge module | 4 discriminating tests; old shape throws; verified in the running container |
| `ff7dc7ef` | Evidence-lane over-fetch, lane instrumentation, access gate | live on `prod-20260806-ff7dc7ef2126`, differential CLEAN |
| `9a89694e` | ICARUS verification CI + index metrics | 68 tests / 29 targets green, fmt + clippy clean, all observed locally first |

### Over-fetch — the second silent-under-return in the same handler

Both evidence lanes fetched exactly `limit`, but the Postgres access join runs **after**
them and removes ids the caller may not see. So a recall returned fewer than `limit`
whenever anything was filtered, even though more allowed segments existed. Identical shape
to the 200-cap that was starving the memory reranker (fixed yesterday) — *a limit applied
before a filter is a silent under-return*. Both lanes now draw a pool (4× limit, capped by
`MNEME_KB_RECALL_POOL_MAX=400`), trimmed back to `limit` so the response contract is
unchanged. The shard lane also now honours `scoreThreshold`, which only Qdrant applied —
without that the lanes disagreed on what counts as a hit and could not be compared.

### The access gate — what actually blocks PG retirement

`doc-access.mjs` is a pure mirror of `appendDocumentAccess`, the one rule that must move
into the slot before it can serve evidence without Postgres. **Not wired into any read
path.** It ships with branch tests *and* with `scripts/amr-access-differential.mjs`, which
runs both implementations over the same real documents and real access contexts and
compares allowed-id sets exactly.

Mismatches are reported **by direction**, because the risk is asymmetric: too strict loses
recall and someone notices; too loose shows one tenant another tenant's documents and
nobody does. Any over-permissive case fails the run outright.

First production run: `contexts=12 mismatched=0 over_permissive=0` → CLEAN.

---

## 2. The measurement that decides B8 — and it says WAIT

The entire `.amr` evidence corpus across all orgs is **23 segments** (22 + 1).

That single number reframes the retirement question. Yesterday's read-compare reported
top-10 overlap **1.00**, which sounds conclusive and is nearly meaningless: on a
22-segment corpus, top-10 covers almost half the corpus. Today's differential is CLEAN
over 12 contexts — also a small sample.

So the honest state is: **the code path is ready; the evidence is not.** Deleting a
working store on this basis would be a decision made from a number that cannot support it.
The instrumentation shipped today (`qdrant_new` / `shard_new` per query) is what will
produce the real evidence — `qdrant_new` durably at zero on real traffic is the gate.

---

## 3. What Postgres is actually still doing (an honest scope correction)

Worth stating plainly because "replace Postgres" is easy to over-claim.

For `.amr` orgs Postgres is **not** the central `hivemind` schema — it is a separate `hm.*`
schema that the embedded agent owns and creates. What lives there:

| Data | Retirable? |
|---|---|
| memory vectors | **already gone** — 100 % shard |
| memory lexical (`hm.memories` mirror) | yes — shard lexical lane covers it (B6) |
| evidence vectors (Qdrant) | yes, once the lane evidence exists |
| evidence content + doc metadata | needs shard-side hydrate (title is the one missing field) |
| document access control | needs the gate above, differential-clean at volume |
| provenance, meetings, TARA ledger, spreadsheet grids | **relational hub — not a recall concern** |

The shard record already carries content, heading, page range, scope and a `doc-id:` tag.
Against the PG hydrate, exactly **two** things are missing: the document title (lives on
`knowledge_documents`) and the access gate. That is a genuinely short list — but it is not
zero, and the last item is the one that leaks tenant data if rushed.

---

## 4. ICARUS / open-source

`release.yml` published binaries; **nothing verified the code worked**. For a storage
engine that gap matters more than any README: a stranger evaluating it is deciding whether
to trust a file format with their data.

`ci.yml` now runs fmt, clippy (`-D warnings`), the full workspace suite, and the durability
tests by name, on Linux **and** macOS — the engine mmaps files and depends on sparse-file
and page-cache behaviour that differs between them. Every gate was run locally and observed
green before being added: **68 tests across 29 targets**, fmt clean, clippy clean. A
workflow that lands red teaches contributors to ignore CI.

Clippy earned its place immediately: it flagged `index_lag` and `add_failures` as dead
code — correct, `mod index` is private so they were unreachable with zero callers. Deleting
them would have been the wrong fix. `add_failures` is documented as *">0 means recall may
be missing vectors"*: indexing is async, so a failed add leaves the segment holding vectors
the HNSW graph does not, and recall silently returns less with **no error at the call
site**. The failure mode this engine is most exposed to, and it was unobservable. Both are
now `Segment::index_lag()` / `Segment::index_failures()` — dead code fixed by making the
metrics usable, not by hiding them behind an `allow()`. Operators should alarm on
`index_failures() > 0`.

---

## 5. Mistakes made today

1. **I mis-read my own truncated log and reported that only 1 of 15 test files ran.** The
   background command piped through `tail -45`, so the log held only the last 45 lines. The
   full run had always executed all 15. Caught by re-running with full capture before
   acting on it.
2. **A deploy failed and printed `EXIT=0`.** I passed a SHA with a stray character; the
   script correctly refused, but the pipe through `tail` masked the status. Same hazard as
   §5.3 yesterday — read the output, never the exit code, on this path.
3. **I briefly believed a parallel session had force-pushed over my commit.** The box's
   clone reported a different tip; the authoritative check from my own clone showed that
   tip was an *ancestor*, five commits back. Check ancestry from a clone you trust before
   raising an alarm — the same rule that applies to gitlink bumps.

---

## 6. Operational findings

- **`/root/hivemind-main`'s `origin` is `/root/hivemind`, not GitHub** — and it is a
  *shallow* clone. So a release can only see commits that have been pulled into the middle
  clone first; a fresh push to GitHub is invisible to the deploy script until then. The
  safe advance is `git fetch origin singulance-main:singulance-main` in `/root/hivemind`,
  which updates the ref only. That branch is not checked out there (HEAD sits on
  `feat/mneme-foundation` with 104 dirty files belonging to another session), so the
  working tree is untouched — verified before and after.
- **Disk is healthy again**: 74 GB free (was 21 GB).
- **The compose-pin hazard is gone**: `infra/docker-compose.hetzner.yml` now reads
  `image: hivemind/core-api:${VERSION:-latest}` and the file is clean.
- **The `hivemind-release.lock` file is stale** — dated 2026-08-02 with no process behind
  it. `release-singulance.sh` uses `flock` on `/run/lock/singulance-production-release.lock`,
  so the stray file is inert, but it reads as an active release to anyone checking by hand.

---

## 7. Invariants added today

- A limit applied **before** a filter is a silent under-return. Over-fetch, filter, then trim.
- Emit from the **merged** candidate set, never from one lane's raw response.
- A pure step trapped inside a closure that needs a native binding is a step that will
  never be tested. Extract it.
- An access rule ported by re-implementation must be **differentially tested against the
  original**, by direction, on real data — not just unit-tested against its author's
  reading of it.
- Do not add a CI gate you have not personally watched pass.

---

## 8. Memory-engine item 2 — documents into the slot (`6a619764`, live)

Scope clarified by the owner: meetings, TARA history and leads **stay in Postgres**. Only the
memory engine is being moved. Measured against that scope, the engine is already further along
than it looked — **8 of 34 routes run with zero Postgres and zero Qdrant**, and they are the
entire memory *read* path (`recall`, `graph`, `hydrate`, `list`, `stats`, `mem-edges`,
`mem-relationships`, `by-tags`).

Item 2 writes `knowledge_documents` into the slot as layer-3 records: the shard-side half of the
access join, and the input `doc-access.mjs` gates against. Additive; nothing reads it yet.

Three decisions where the obvious version was wrong:

1. **Authoritative, not denormalised.** Copying title + grants onto each segment is the shortcut.
   It is also a leak: scope-key grants change (shared → un-shared) and per-segment copies keep
   answering with the OLD grants. One record per document, rewritten by the same upsert.
2. **Layer 3, excluded structurally.** `insert_layered` takes a `u8`, so 0/1/2 was convention, not
   a format limit. Document records carry a zero-vector placeholder, so they *rank* last — but
   ranking is not a guarantee, and an over-fetched pool on a 23-segment corpus returns them
   regardless. All three recall paths exclude the layer explicitly, **including `mneme-recall`'s
   all-layer lane** — which recalls every layer deliberately (cross-layer recall is a feature) and
   was therefore precisely the lane that would have served them as fake memories.
3. **Lifecycle routed — and it exposed a pre-existing bug.** `kb-doc-delete` removed segments from
   Postgres and Qdrant but left them in the shard's evidence layer. Harmless ONLY because the
   access join drops rows whose document is deleted — which stops being true the moment the shard
   serves reads. Fourth lifecycle this delete has needed (after derivations, evidence links, grids).

**Verified live**: doc backfill `{pg:7, written:7, failed:0}`; recall returns 60 candidates with
**0 document-layer leaked**, layers `{memory:38, evidence:22}` intact, and opt-in reads all 7 back.

### Mistake repeated
`isNonRecallable` was first written inside `amr-store.mjs`, which loads the native binding at
module scope — so its test could not run off-box. That is the *same* trap that hid the kb-recall
crash, repeated within hours of writing it down. Moved to a binding-free `layers.mjs`. Writing an
invariant into a journal does not stop you from violating it; only making the wrong thing hard does.

### Item 1 (drop the write mirror) — corrected estimate
Called "small" earlier; it is not. Two findings:
- The stale comment on `/v1/lexical` claims the shard index "cannot express" layer/temporal
  filters. **Untrue** — `_passesFilter` handles `known_at` and the valid-at snapshot, and the shard
  union already receives the same filter object. That half is done.
- But the mirror has a **second reader**: `countDerivedMemories`, backing the "N memories from this
  document" count on the KB list. It must be ported to `findByTags` + a metadata scan before the
  mirror can be retired.

---

## 9. CORRECTION — "relations never reach the shard" was WRONG (`0d683e1a`)

Claimed, on the basis of a live upload, that KB-ingest relationships were landing only in
Postgres: `[kb-relations] written=2`, `hm.relationships` = 9 rows, and the org's
**`shard.edg` = 0 bytes**. Shipped `0d683e1a` to "fix" it.

**The premise was false.** `EDGE_SLOTS = 4`: the first four typed edges per memory are stored
**inline in the slot header's 32-byte adjacency region**, and `.edg` is only the *overflow*
region beyond that. An org whose memories each have ≤4 edges has a legitimately empty `.edg`.
File size was never evidence of edge count.

Verified through the live API afterwards: relationships come back, and their ids are
`e:<from>:<to>:PartOf` — the shard's synthesized edge-id form. Postgres rows carry real UUIDs.
The edges were in the slot the entire time.

**What actually gave it away**: the warning added in the same commit fired **zero** times. If
the org had been unresolved — the whole basis of the diagnosis — it would have fired on every
edge. The instrument built to confirm the theory refuted it instead, one deploy later.

`0d683e1a` is therefore **not a bug fix**; its commit message overstates. What it does is still
correct and worth keeping: the ingest call sites pass `org_id` explicitly instead of relying on
AsyncLocalStorage surviving a worker boundary (same value, no behaviour change), and an
unresolvable org is now audible. Kept, relabelled here rather than by rewriting pushed history.

**Lesson, and it is the same one as §0 in a new costume**: a proxy measurement is not the
measurement. `.edg` bytes proxied for "edges exist" the way top-10 overlap proxied for "the
lanes agree". Both were read as conclusive; both were about the artefact, not the property.
Ask the system for the property directly — here, one API call for the actual relationships,
which was available the whole time and would have cost less than the investigation did.
