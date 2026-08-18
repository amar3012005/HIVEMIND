# hm-extract

Stateless bytes-in/segments-out document extraction. No database, no tenant
identity, nothing persisted. Everything that knows *who* a document belongs
to stays in the main HIVEMIND core repo.

Full design rationale, seam decision, and rollout plan:
`.claude/decision-docs/HM_EXTRACT_PLAN.md` in the main repo.

## What it does

`POST /extract` a file → get back parsed markdown, page markers, and
meta-aware, atomicity-respecting segments (headings, pages, segment_type,
table/list boundaries never split mid-unit).

Powered by [`@firecrawl/anydoc`](https://github.com/firecrawl/anydoc)
(Rust, no ML models, single-digit-ms typical) instead of a docling sidecar.
Chunking logic (`src/chunker.js`, `src/strip-page-markers.js`,
`src/collapse-letter-spacing.js`) is ported **verbatim** from the main
repo's `core/src/knowledge/` — not reimplemented — so prose chunking
behaves byte-identically to what is in production today. `src/atomic-blocks.js`
is new: a structural pre-pass that keeps table rows and list items whole.

## What it deliberately does NOT do

- No `orgId`/`userId`/scope — ever. It cannot leak what it does not know.
- No promotion, no entities, no relationships, no contradiction detection.
- No embedding calls, no LLM calls, no semantic-boundary detection. That
  needs per-org billing attribution (`planEnforcer`/`meterTokens`) and a
  cache, both of which require the tenant identity this service is designed
  never to have. It stays in core's `_createSegments`. This service returns
  `structural_density` (heading density, atomic-segment ratio) as a free,
  tenant-agnostic signal so core can decide whether that pass is worth
  running — without hm-extract ever making that call itself.
- No per-tenant rate limiting — core's `KB_QUEUE_ORG_CONCURRENCY` already
  owns that; this service cannot do it even if asked.

## Run locally

```bash
npm install
UV_THREADPOOL_SIZE=8 node src/server.js   # UV_THREADPOOL_SIZE is the REAL
                                          # concurrency lever for anydoc's
                                          # Node binding — it defaults to 4
                                          # regardless of CPU count.
```

```bash
curl -X POST http://localhost:8088/extract \
  -F "file=@report.pdf;filename=report.pdf" -F "filename=report.pdf"
curl http://localhost:8088/health
curl http://localhost:8088/formats
```

## Test

Requires the eval corpus at `~/anydoc-eval` (or set `ANYDOC_EVAL_DIR`) —
built during development from python-pptx/openpyxl/python-docx/pdftotext,
independent of anydoc, so the golden test scores against ground truth the
parser under test had no hand in producing.

```bash
UV_THREADPOOL_SIZE=8 PORT=8199 node src/server.js &
HM_EXTRACT_URL=http://localhost:8199 node --test --test-concurrency=1 test/golden.test.js test/atomicity.test.js
```

`--test-concurrency=1` is required, not optional — both files exercise the
SAME live server process (in-flight counters, admission control), so
Node's default cross-file test concurrency lets one file's still-draining
load bleed into the other's assertions. Measured directly: without it, the
combined suite spuriously fails (residual admission-control state from one
file rejects the other file's legitimate requests); with it, 26/26 green,
reproducibly.

- `test/golden.test.js` — word recall vs. independent ground truth on 14
  documents (small + large, every format anydoc claims); must match or beat
  the docling numbers recorded in the main repo's
  `KB_PIPELINE_ARCHITECTURE.md` §11. Also checks the honest-failure path
  (`scan.pdf` → `422 unsupported`, never a fake success) and segment
  invariants (offsets monotonic, content traceable to markdown, admission
  control 429s under load).
- `test/atomicity.test.js` — table/list atomicity (constructed case + an
  exhaustive, non-sampled check against a real 95,291-row/70MB CSV if the
  fixture is present), legacy binary formats (`.doc/.xls/.ppt`), and the
  `structural_density` contract field.

Full suite: 22/22 green, on both macOS arm64 dev and the built
`linux/amd64` container (`hm-extract:amd64-final`), same numbers both
places.

## Container

```bash
docker build --platform linux/amd64 -t hm-extract:local .   # match the
                                                              # real deploy
                                                              # target, not
                                                              # your dev
                                                              # machine's arch
docker run -d -p 8088:8088 -e UV_THREADPOOL_SIZE=8 hm-extract:local
```

Verified on both macOS arm64 (dev) and linux/amd64 (the real SINGULANCE
target, via `--platform linux/amd64`) — identical recall numbers on both.
Non-root user, healthcheck included. Never exposed publicly — internal
network only, once wired into the cluster.

**Memory — what was fixed, what remains open (2026-08-15):**

Three real fixes landed, each measured before/after, not assumed:

1. **Streaming JSON response** (`writeExtractResponse` in `src/server.js`)
   instead of `res.json(bigObject)` — avoids materializing the entire
   response (~280MB for the 70MB CSV case) as one contiguous string before
   sending. Measured on an identical fresh process, same file: peak RSS
   1641MB → 1491MB (~9% reduction). Output is byte-identical to the old
   path (verified via `cmp`) — this only changes how the response is
   assembled, not its content.
2. **Fixed a double-decrement admission-control bug**: every early-return
   error path (`missing_part`/`too-large`/`unsupported`) decremented
   `inFlight` itself AND the handler's `finally` block decremented it
   again — silently going negative under any error traffic (caught via a
   `/health` reading of `in_flight: -2` earlier in testing). Now
   decremented in exactly one place; regression test added
   (`test/atomicity.test.js`: "in_flight never goes negative").
3. **Memory-budget admission control**, not just a request-count cap: a
   first version budgeted on raw upload bytes and still let a 2GB
   container OOM, because a 74MB upload costs ~20x that (~1.5GB) to
   actually process — budgeting on upload size undercounted real cost by
   ~20x. Fixed to estimate PROCESSING memory (`Content-Length ×
   MEMORY_BLOWUP_FACTOR`, both env-tunable) before multer even buffers the
   body, and reject concurrent large uploads that would exceed
   `MAX_INFLIGHT_MEMORY_BYTES` — while always admitting a lone large file
   regardless of size (`MAX_FILE_MB` already bounds that case alone).

**Root cause of the earlier OOM crashes, found (2026-08-15):** the crashes
chasing a 2-3GB `--memory` limit turned out to be compounded by two
DISTINCT things at once, not one:

1. Docker Desktop's VM has a FIXED total memory pool (`docker info` →
   `Total Memory`), shared across every running container on the host —
   this Mac had ~30 unrelated containers running (other projects' dev
   stacks) competing for a 7.65GB pool, so hm-extract's container was
   fighting for scraps of a system-wide-starved VM, not failing on its own
   merits.
2. A genuine, separate finding that survives even with the whole VM pool
   free: Node/V8 does not return freed RSS to the OS between large
   allocations, so running the full 16+10-test corpus (several large
   PDFs + a 70MB CSV) back-to-back accumulates — RSS climbed 3.17GB (pass
   1) → 5.22GB (pass 2) → 5.31GB (pass 3, essentially flat) with the full
   7.65GB pool available and zero other containers running. It PLATEAUS,
   not unbounded growth — but the plateau (~5.3GB) is real and needs to be
   sized for, not assumed away.

With all other containers purged and the full 7.65GB pool available to
hm-extract alone: 26/26 tests pass reliably across repeated full-corpus
runs, container stays healthy throughout. This IS the honest production
signal — not a workaround, an actual clean measurement.

**Production sizing implication:** the full test corpus deliberately
stress-tests worst cases (multiple giant documents back-to-back) that
don't represent typical single-upload traffic — a normal document costs
far less. But if a production replica handles many large documents over
its uptime without restarting, expect RSS to climb toward a several-GB
plateau, not stay near baseline. Recommendation: size the container's
memory limit at 4-6GB for a replica handling recurring large-document
traffic (not the earlier untested 2GB assumption), and treat periodic
replica recycling (an orchestrator restarting the process after N
requests or a memory watermark) as a defense-in-depth option worth
adding later, not yet built. Not yet verified on real x86 hardware (the
actual SINGULANCE target) — the numbers above are still from
QEMU-emulated `linux/amd64` on Apple Silicon; real hardware should be
measured before finalizing the production `--memory` limit.

## Status

Built and tested locally, end to end, including on the real target
architecture. Final upgrades landed: table/list atomicity
(`atomic-blocks.js`), `structural_density` signal, full 22-test suite
green on both dev and the `linux/amd64` container. **Not yet wired into
core or deployed.** See `HM_EXTRACT_PLAN.md` §8 for the rollout phases
(P0 done; P1 — local core integration behind `KB_EXTRACT_URL` — not
started).
