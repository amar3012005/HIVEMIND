# hm-extract — detailed build + rollout plan

Status: **planned, not built.** Extends `~/anydoc-eval/HM_EXTRACT_SPEC.md` (the
API contract) with implementation, concurrency, failure-mode, and rollout
detail for running this at hundreds-of-tenants scale. That file is the
contract; this file is how to build and ship it without it becoming a second
core.

## Direct answer to "is this a great plan for multi-tenant, hundreds of users"

**Yes, for parse+chunk only. No, if it grows into full ingestion (memory
generation included).** Two separate claims, argued separately, because the
scaling story is opposite for each half.

### Why parse-only is the right shape at scale

A service that never receives `orgId`/`userId`/scope **cannot leak across
tenants** — there is nothing tenant-shaped in it to leak. That is what makes
horizontal scaling free: replicate it, crash it, redeploy it under load,
nothing tenant-critical ever lived in its process. This is *better* than what
runs today — `hm-docling` is a 9GB stateful sidecar with a fixed worker count
sized to avoid OOM; `hm-extract` is stateless bytes-in/segments-out, so the
sizing problem mostly goes away.

### Why folding in memory generation is wrong, even at scale — not just "risky"

The moment this service does promotion (entity resolution, relationship
classification, contradiction detection, scope stamping), it needs DB +
Qdrant + amr-shard credentials for every tenant. It stops being a helper and
becomes **a second core**. Every tenant-isolation invariant this codebase has
had to fix this month — evidence not respecting scope, personal lens
admitting project documents, the global dream-budget serializing every
org's dreaming against one row — would need to be correctly re-implemented
in two places instead of one. That is not a scaling win; it is doubled
attack surface for exactly the bug class this session kept finding.

It also doesn't solve a real bottleneck. Measured on a real ingest:

```
parse=4609ms  seg=2118ms  embed=2054ms  promote=39482ms   (82% of wall time)
```

Promotion dominates, but it is **LLM-latency-bound**, not CPU-bound —
`await fetch()` to an LLM provider does not block Node's event loop the way
docling's synchronous OCR/layout models did. The property that justified
carving parsing out (CPU-heavy, crash-prone, heavy native deps, zero tenant
context) does not hold for promotion. Scaling promotion is "run more core
replicas behind the existing queue," not "build a new service."

### What core's existing queue already gives us — do not duplicate it here

`core/src/knowledge/kb-ingest-queue.js:43-44`:
`KB_QUEUE_CONCURRENCY=6`, `KB_QUEUE_ORG_CONCURRENCY=4`. That is the
per-tenant fairness layer today, and it stays exactly where it is.
**`hm-extract` never sees `orgId`, so it structurally cannot do tenant
fairness — and it shouldn't try.** Worth stating outright so nobody expects
per-tenant rate limiting from this layer; core already owns that.

---

## 1. Runtime choice

Node/Express, not a Rust-native server. Two reasons:
- The existing semantic chunker (`chunkText`, offset/heading walk,
  `stripPageMarkers`, `collapseLetterSpacing`) is JS, already tested, and
  already has a caught word-joining bug fixed in it. Porting that logic to
  Rust to match a Rust-native anydoc server risks reintroducing bugs already
  found and fixed once.
- anydoc's own docs: *"Node.js conversion runs on the libuv thread pool and
  never blocks the event loop."* So a single Node process already
  parallelizes the CPU-bound anydoc calls across libuv's thread pool — no
  cluster module or worker_threads needed for that part.

**Concrete concurrency knob:** libuv's thread pool defaults to **4**
regardless of CPU count. Set `UV_THREADPOOL_SIZE=<cpu_count>` in the
container, or concurrent `toMarkdown` calls silently queue behind 4 threads
even on an 8/16-core box. This is the actual lever; "concurrency = CPU count"
in the original spec was directionally right but not a config value on its
own.

## 2. Admission control (the gap in the original spec)

A stateless service with no backpressure just queues everything until it
falls over. Add:
- **In-flight cap** = `UV_THREADPOOL_SIZE + small buffer` (e.g. +8). Beyond
  it, return `429` with `Retry-After`, not a slow 200.
- **Per-request timeout** (30s) even though anydoc is fuzz-tested and
  measured at single-digit ms — belt-and-suspenders against a pathological
  input the fuzzer didn't cover.
- **`MAX_FILE_MB` check before the anydoc call**, on `Content-Length` or the
  buffered size, not after — this is what the 9GB docling memory limit was
  compensating for; a bounded, cheap parser needs a much smaller number
  (start at 100MB) and should reject fast rather than attempt.

## 3. Runtime fallback, not just a static flag

`KB_EXTRACT_URL` set/unset (from the original spec) decides which code path
core takes at deploy time. That's necessary but not sufficient — add a
runtime circuit breaker in core's caller:
- Non-2xx, network error, or timeout from `hm-extract` ⇒ **fall back to
  today's parser path for that request**, not fail the upload.
- N consecutive failures (e.g. 5) ⇒ skip `hm-extract` for a cooldown window
  (60s) so an incident in the new service can't retry-storm itself or core.

This means `hm-extract` having a bad minute during rollout never regresses
reliability below today's baseline — core degrades gracefully to the parser
it already trusts.

## 4. Availability — replicas, not just throughput

anydoc is fast enough that one instance can likely absorb real load
(sub-5ms median per the vendor benchmark, confirmed in our own measurements).
Redundancy here is for **crash isolation**, not throughput: run **2+
replicas** behind a simple round-robin (core's HTTP client picks from a
small static list, or an internal Caddy/nginx hop) so a single process crash
on a malformed file — however rare given anydoc's fuzz-testing and our own
`MAX_FILE_MB`/timeout guards — never takes down extraction platform-wide.

## 5. Observability

Log per request: format, byte size, engine used, timing, error code. **Never
log bytes or extracted text** — the original spec's non-functional
requirement, restated because it's easy to violate accidentally in a debug
log line.

## 6. Container layout

```
hm-extract/
  Dockerfile              # node:22-slim base, no native deps beyond anydoc's prebuilt binary
  package.json            # @firecrawl/anydoc, express, the ported chunker module
  src/
    server.js              # /extract /health /formats
    chunker.js              # ported verbatim from document-first-ingestion.js's
                             # semantic-chunk loop + document-chunker.js's chunkText
    strip-page-markers.js   # ported verbatim from document-first-ingestion.js
    errors.js               # anydoc ConvertError -> our {code, detail, retry_with} shape
  test/
    golden.test.js          # runs every file in ~/anydoc-eval/docs against gt.json,
                             # asserts recall >= the docling numbers already recorded
```

Porting `chunker.js` and `strip-page-markers.js` **verbatim** (not
rewritten) is deliberate — those two files carry fixes already paid for this
session (the offset-anchor fallback, the word-join bug). Rewriting them
"cleaner" for the new service risks paying for those bugs twice.

## 7. Test plan (extends the original spec's §Test plan)

1. Golden file over all 22 documents now in `~/anydoc-eval/` (14 original +
   8 large), scored against `gt.json`. Must match or beat the docling numbers
   already recorded there — this is the existing bar, not a new one.
2. `scan.pdf` → `422 unsupported`, never a fake `200`.
3. Segment invariants: offsets monotonic, `content` a verbatim substring of
   `markdown`, no mid-word splits (this is exactly what the strip-markers
   word-join bug would have violated — assert it directly), `contentHash`
   stable across repeated runs on identical bytes.
4. A real legacy `.doc`/`.xls` fixture — none in the corpus today; anydoc's
   support for these is claimed, not yet verified here.
5. **Admission control test**: fire more concurrent requests than the
   in-flight cap and assert `429` + `Retry-After`, not degraded latency or a
   crash.
6. **Fallback test**: point core's `KB_EXTRACT_URL` at a deliberately broken
   endpoint and confirm core's caller falls back to the existing parser path
   and the upload still succeeds.
7. Linux/container run of `toDocument` — already confirmed broken on macOS
   arm64 (`Failed to create reference from TypedArray`, every input including
   a 19KB docx). If it works on Linux and the Rust model carries page
   provenance, that reopens whether anydoc could also take pptx/pdf — a
   decision to make later, not assumed now.
8. Core wired behind `KB_EXTRACT_URL` with the runtime fallback from §3. Both
   paths live for one full release; `hm-docling` deleted only after the flag
   has run clean with zero fallback-triggering incidents.

## 8. Rollout phases

- **P0 (local)** — build the container, run the golden-file suite, no
  network exposure, no compose wiring yet.
- **P1 (local e2e)** — `docker compose` with a local core pointed at
  `KB_EXTRACT_URL=http://hm-extract:PORT`, upload the same test corpus
  through the real ingestion path, diff resulting segments/memories against
  today's docling-produced output on the same files.
- **P2 (SINGULANCE, dark)** — deploy as an additional compose service,
  **internal network only, never exposed via Caddy**, flag off by default.
- **P3 (SINGULANCE, docx/xlsx/legacy only)** — flip the flag on for the
  formats where docling already gives zero page provenance today
  (`pages=0`/`texts=0` measured), so nothing is lost even in the worst case.
  pptx/pdf continue through docling.
- **P4 (monitor)** — one release watching error rate, latency, and
  fallback-trigger rate. Clean run required before touching pptx/pdf.
- **P5 (decision point, not assumed)** — only if page citations are formally
  deprioritized (per the "quota doesn't need page numbers, that's already
  handled by `countPages()`" decision), revisit whether pptx/pdf can also
  move to anydoc. Three live recall paths currently read `start_page`
  (`recall-packet.js:144`, `recall-router.js:1824`,
  `evidence-retrieval.js:261`) — confirm with the user whether those degrade
  acceptably to `page: null` before flipping this, don't assume it.
- **P6** — delete `hm-docling` sidecar, its OCR models, and drop the
  LibreOffice dependency that was never actually added, once P4/P5 confidence
  is high.

## Non-goals, restated plainly

- No tenant identity, ever, in this service.
- No promotion, no entities, no relationships, no contradiction detection —
  that stays in core regardless of how compelling "just add memory
  generation too" looks. See the argument at the top of this file for why.
- No per-tenant rate limiting here — core's existing `KB_QUEUE_ORG_CONCURRENCY`
  already owns that.
