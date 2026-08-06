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
