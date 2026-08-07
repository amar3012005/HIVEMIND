# KB Pipeline — Final Architecture (FE → parse → segments → memories → recall)

Status: **as-built and verified on SINGULANCE, 2026-08-06**, release
`prod-20260806-a6441e71`. Every number here was measured on this deployment, not
estimated. Where something is assumed rather than measured, it says so.

Supersedes the format/tier guesswork in `kb_failproof_plan.md` and
`kb_durability_plan.md` for anything they disagree on.

---

## 0. The one rule this document exists to enforce

**Verify state by asking the running system, never by trusting what you or another
session said five minutes ago.**

Today's near-misses were all caught by re-querying Docker/git at the moment of
action: a release script that printed `PROMOTED` over a container still running
the old image, a stale `origin/singulance-main` read, a remote re-point that hit
the parent repo instead of the submodule, an almost-deleted running image matched
by tag instead of ID.

---

## 1. Accepted formats (the contract)

`core/src/knowledge/upload-contract.js` → `KB_EXTENSIONS`. The FE mirrors it in
`KnowledgeBase.jsx` → `ACCEPTED_EXTS`. **These two lists must move together** — a
client-side accept the server refuses is a guaranteed 415, and a client-side
refusal of something the server handles is an invisible capability loss (that is
exactly how pptx stayed dead for weeks after its cause was fixed).

| Kind | Extensions |
|---|---|
| document | `pdf docx xlsx pptx txt md markdown csv tsv html htm` |
| image | `png jpg jpeg tiff tif webp gif` |
| audio | `mp3 wav m4a flac ogg` |

**Deliberately refused:** `ppt doc xls` — legacy *binary* formats. Docling reads
OOXML natively (python-pptx / python-docx / openpyxl are present in `hm-docling`)
but the binaries need LibreOffice, and `command -v soffice` in that container
returns nothing. Refusing fast beats failing slow.

**Untested, therefore not accepted:** `odt ods odp rtf epub xlsm docm pptm`.
`FORMAT_PROFILES` has entries for them; an entry is not evidence. Do not add them
to `KB_EXTENSIONS` without a measured round-trip.

---

## 2. Routing — which parser handles what

Two seams. `normalize.js` handles text-ish formats without ever calling docling.
Everything else goes through `server.js` → `doclingAdapter.parseBuffer` →
`docling-adapter.js` → the `hm-docling` sidecar.

| Input | Tier | Measured |
|---|---|---|
| `txt md markdown csv html htm` | `plain-text` / `markdown-native` / `html-markdown` (normalize seam) | instant, no docling |
| `pdf` | docling `{smart, ocr, tables, pics}` → **vision** → **fast-pdf** | 1.4–2.2 s/page CPU; 99.0% / 94.6% word recall on 92pg / 52pg |
| `docx` | docling `{smart, tables}` | 0.08–0.2 s, 99–100% |
| `xlsx` | docling `{smart, tables}`, never OCR | 0.01 s, 100% |
| `pptx` | docling `{smart}`, **`pics:false`** | 0.2–12.4 s, 100% |
| images | groq-vision (NOT docling OCR) | see §2.2 |
| audio | Groq Whisper | — |

### 2.1 fast-pdf is the FALLBACK, not the default

This is counter-intuitive and was re-litigated twice. `fast-pdf` (pdf-parse) is
faster and, on flat prose, loses nothing. It is still wrong as the default: on a
54-page deck it returned `tier=fast-pdf ms=757` with the 7-row inverter matrix
flattened to loose text and every figure gone, and on a 46MB PDF it emitted
letter-spaced display text (`S O L V I S`) that produced **240 segments and zero
memories**.

Benchmarking docling-PDF against `pdftotext` scores flat-text extraction and is
**blind to the table structure that demotion was about** — that comparison
"proves" fast-pdf wins and is measuring the wrong thing. On the one file where
both were measured against structure, docling produced 151,529 chars vs
pdftotext's 81,568.

Fallback order on empty/failed PDF parse: **vision first, fast-pdf last.**

### 2.2 Images go to vision, not docling OCR

`hm-docling` auto-selects **RapidOCR** (PP-OCRv4 mobile, onnxruntime, CPU —
`Accelerator device: 'cpu'`). It produces structurally impressive markdown tables
from a screenshot but **merges digits across cells**: a real budget grid came back
with `20.00016.000` and `30.00035.00030.00016.50016.500`, plus `ldentitatsentwicklung`
and `0kt26`. Authoritative-looking and wrong is the worst failure mode for
financial data. Route images to vision.

---

## 3. Docling transport — already correct, do not "fix" it

Read `docling-adapter.js` before changing anything here. The following are already
implemented and were each written in response to a specific incident:

- **Async by default.** `useAsync = smart || fileSize > 4MB`, and layout formats
  default to `smart`, so essentially every docling call already uses
  `/v1/convert/file/async` → `/v1/status/poll/{id}` → `/v1/result/{id}`.
  The sync endpoint's `max_sync_wait=180` 504 only affects code that calls it
  directly — a benchmark harness, not this pipeline.
- **Task-vanished guard.** 3× consecutive 404 on poll ⇒ fail fast to the fallback.
  A 404 means the worker died (OOM), not "not ready"; treating it as transient
  burned the full 600s on a 54-page deck.
- **Parse ceiling derived from the job budget** — `PARSE_CEILING_MS = 55% of
  KB_QUEUE_JOB_TIMEOUT_MS`, so the parser can never outlive the job that owns it.
- **`md_content` / `text_content`** are the real response fields. `markdown` /
  `text` and `export_to_markdown()` are not — reading them made every parse look
  empty with no error.
- **Provider-rejects-reasoning retry.** Deliberate: retry once without the field
  rather than maintain a model allow-list. Costs one round trip per gpt-oss call;
  that trade was made knowingly.

### 3.1 Sidecar sizing — measured, do not raise casually

`hm-docling`: `mem_limit 9g`, `cpus 3.0`, `ENG_LOC_NUM_WORKERS=3`,
`MAX_SYNC_WAIT=180`. Peak is ~3.1 GiB for a 54-page enriched PDF; idle ~1.6 GiB.
Host has 15G total / 8 CPUs. History: 2 workers against a 2g limit OOM-killed the
container **and took Redis down with it**.

`KB_QUEUE_CONCURRENCY=6` / org-cap 4 is **not** the bottleneck and should not be
lowered — the serial point was the sidecar. (A 2026-08-06 OOM that looked like
queue pressure was actually an ad-hoc harness pushing 6×90 MB uploads straight at
docling, bypassing the queue entirely.)

Image is **pinned by digest**, not `:latest`:
`ghcr.io/docling-project/docling-serve@sha256:69f7c33d…` (= v1.25.0).

### 3.2 Batch upload exists and should not be used

`/v1/convert/file[/async]` accepts a plural `files` field and returns a ZIP.
Measured: 3 files → one task → 9.1 s ≈ the serial sum. **One task = one worker**,
so batching buys no parallelism and costs per-file retry, per-file DLQ, per-file
status and per-file scope. `/v1/convert/source/batch` is JSON/URL-only and cannot
take uploaded bytes at all. The BullMQ per-file job model is the better batcher.

---

## 4. Empty extraction is a failure, for every format

Docling answers `HTTP 200 / status: success` with a near-empty body on an
image-only document: a 3-page scan returned **46 chars** (three `<!-- image -->`
markers), and **104 chars even with `do_ocr=true`**. Left alone, that body flows
into chunking and embedding and the document finishes marked `ready` while holding
nothing. Recall cannot return what was never extracted, and nothing says so — a
green tick over an empty document is worse than a visible failure.

- `usableChars < 200 && usableChunks === 0` ⇒ `parseFailed`.
- PDF ⇒ vision, then fast-pdf.
- **Every other format ⇒ hard error** (no render path exists for them), so the
  queue can retry and the user can see it.

`parseFailed` requires `usableChunks === 0`, so a document whose chunker survived
is never failed by this.

---

## 5. Segments — the evidence layer

`document-first-ingestion.js`. Semantic re-slice of the parser's markdown (NOT
docling's HybridChunker, which cuts mid-word: `visBruno7kW`).

Every segment carries, on **both** the semantic-upload path and
`ingestConnectorRecord`: `scope`, `scope_key`, `project_id`, `team_id`,
`document_title`. That is what lets scope lenses filter memories *and* evidence
identically on central, `amr_embedded` and `byod_amr` — without a document join
the remote agent cannot do.

### 5.1 Page attribution — what is citable

`start_page` comes from markers in the markdown, in priority order:
`<!-- page N -->` (docling native) → `-- N of M --` (fast-pdf) → parser
`hybridChunks[].page` (authoritative when present) → form-feed fallback.

| Format | Page provenance |
|---|---|
| pdf | ✅ native markers |
| pptx | ✅ **synthesised** from `texts[].prov[0].page_no` (§5.2) |
| docx | ❌ none — docx has no fixed pages (`pages=0`) |
| xlsx | ❌ none — content is tables, `texts=0` |

### 5.2 The pptx slide-number trap

Docling emits **no page break at all** for pptx, even with
`md_page_break_placeholder` set (measured: 0 markers). The page is not missing,
only unrequested: it lives in `texts[].prov[0].page_no`, which appears **only when
`to_formats` includes `json`**. The adapter historically sent no `to_formats`, so
it received markdown alone.

`injectPageMarkersFromProv()` now requests `md` **and** `json` for slide formats
and *inserts* `<!-- page N -->` before each page's first text. Two traps:

1. **Request both formats.** Asking for `json` alone returns `md_content: null`,
   which would blank every parse.
2. **`prov.bbox` lies about its origin.** It reports `coord_origin: BOTTOMLEFT`
   and `b < t` in every box, which reads as y-up. It is not. Verified against
   python-pptx on the same deck: bbox `b` equals the true top-down `top`
   (`The Problem` b=878383 / pptx top=878383). **Sort by `b` ASC.** Sorting by `t`
   returns every slide upside-down while still looking entirely plausible.

Fabrication guard: a marker is written only where a page's first text actually
resolves, scanning forward so a repeated footer cannot drag a later page
backwards, and the pass is abandoned below two distinct pages. On the reference
deck 11 of 15 resolve — slide 2 is image-only, three late slides have no unique
anchor. **They stay `null` rather than guessed.** Measured effect: `with_page`
0/9 → 6/9, warning gone, `parseText` unchanged at 5009 chars.

### 5.3 Unembedded-segment healing

A segment whose inline embed fails exists in Postgres, looks fine in the UI, and
is permanently unsearchable. `[embed-reconciler]` sweeps for them:
`orgs=2 checked=733 missing=1 embedded=1 failed=0`. This is the last silent
data-loss path and it is closed.

---

## 6. Memories — extraction and curation

Windowed distill over the markdown, facts-only, every fact carrying provenance.

- **Grounding.** A fact survives only if its `source_quote` locates in the source.
  `locateSourceQuote()` is whitespace/dash/quote-tolerant and *repairs* the quote
  to the real bytes; a hallucinated quote still fails. (The original byte-exact
  `includes()` discarded any quote spanning a line wrap and produced
  "EXTRACTION SHORTFALL: kept 0 facts" with no log line — for a long time this was
  misattributed to the extraction model, and model benchmarks scoring "verbatim
  quote ratio" were in fact scoring this filter.)
- **Drop accounting.** `[kb-normalize] in/kept/repaired/dropped{shape,type,
  short_quote,quote_absent,noise,low_importance,capped}` plus an `UNACCOUNTED=`
  self-check. Seven AND-ed conditions meant "0 facts" had seven silent causes.
- **Salience cap.** Over `maxFacts`, keep highest importance, restore original
  order, and record the count in `drop.capped` — never a silent truncation.
- **Shortfall escalation.** Below expected yield, retry on a second model family
  (`openai/gpt-oss-120b`). Observed: `0 facts → 2`, `6 → 9`.
- **Line-item merge.** Table rows merge into one contextual memory: the same
  5-page budget went from 31 memories averaging 154 chars to 17–20 averaging ~235.

Then: canonical entities → `kb-relations` → consolidate → **hybrid cross-doc
linking** (`1 batched LLM call over 40 gray-zone pairs → 12 edges`) → curate →
promote. Cross-doc linking *is* instrumented; the counters are in `[kb-unified]`
and `[kb-hybrid-rel]`.

Reference timing, 15-slide pptx: `parse=4609ms seg=2118ms embed=2054ms
promote=39482ms` → 9 segments, 21 memories. **Promotion dominates**, not parsing.

---

## 7. Recall

Scope-filtered over memories + evidence segments, with source attribution in the
answer: `«singulance-ba-01.pdf : A once-per-category window» …`. Verified live.

Governance (dreaming, bridge synthesis, compression, retention) runs on a
**shared daily token pool**, `PHASE_E_POOL_DAILY_BUDGET`, default 1,000,000.
When exhausted, `[gov-cycle] shared token pool exhausted (spent=…/1000000)` and
cycles skip until the daily reset. That is the circuit breaker working, not a
fault — but it means **dreaming silently stops for the rest of the day**, so the
budget is a cost/quality dial someone must own.

---

## 8. Deletion

Verified twice on 2026-08-06: 7 tables `1|1|2|1|1|1|2` → all `0`; and two live
API deletes returning `deleted_memories: 21` and `16` with no orphans. Dedup is
sha256 **content**-based and **per scope** — the same file may live in My Space
and a project, is refused twice in one scope, and is accepted again after delete
(a stale `ready` job no longer blocks re-upload forever).

---

## 9. Parallel-session deploy rules

Multiple sessions deploy to this box simultaneously. On 2026-08-06 that produced:
`origin/singulance-main` moving 7+ times mid-work, 80+ `hivemind/fe` tags in one
day, disk falling 93 GB → 11 GB free in under an hour, a stale git remote pointing
a clone at the wrong repository, and a near-deletion of a running `core-api` image
matched by tag instead of ID. None of it malicious — it is what unsynchronised
parallel deploys do by default.

1. **Never force-push `singulance-main`.** `fetch` → `rebase` → plain `push`, and
   let it reject. A plain push failing is the only thing that caught a stale base
   today; `--force` would have silently overwritten another session's commit.
2. **Re-fetch the tip immediately before building**, not at session start. A SHA
   resolved at 2pm and built at 2:15pm may already be superseded.
3. **Tag every image with the exact commit SHA** — `prod-YYYYMMDD-<sha>`. Never
   `latest`/`current`/a bare date. It is the only way two sessions can distinguish
   "my image is still running" from "someone replaced it".
4. **Check what is running by image ID, not name or tag**, immediately before any
   delete: `docker inspect <c> --format '{{.Config.Image}}'`. A tag can be stale
   on an image that is still live.
5. **Record the rollback target BEFORE recreating**, never after — inspecting
   afterwards returns the new image, so the pointer is useless exactly when needed.
6. **Never build from a dirty working tree.** Build from a clean checkout of the
   pushed SHA; nothing marks an image as coming from an unclean source.
7. **One deploy at a time, enforced by `scripts/release-lock.sh`** — by lock, not
   by convention.
8. **Verify the running container, not the build log.** See §9.1 — this is not
   theoretical here.
9. **Assume disk is contested.** `df -h /` before a build.
10. **If you re-point a git remote, verify `pwd` and `git rev-parse
    --show-toplevel` first.** An uninitialised submodule path resolves to the
    PARENT's `.git`, so you silently change the parent's remote. Invisible until
    the next fetch does something unexpected — the most dangerous item here.

### 9.1 The compose-tag landmine (live, unfixed)

`docker-compose.hetzner.yml` (service `core`, project `hivemind`) and
`docker-compose.next.yml` (service `frontend`, project `hivemind-next`)
**hardcode image tags**. Nothing reads `${VERSION}`.

So `release-singulance.sh`: builds `core-api:<RID>` correctly → bumps `VERSION=`
in `.env` → `docker compose up -d`. The env change alone forces a recreate, so
the log reads `Recreated / Started` and even passes a health check — while the
container starts from the **old hardcoded tag**. Observed twice today.

Until the script is fixed, after every release:

```bash
# core
sed -i "s|image: hivemind/core-api:.*|image: hivemind/core-api:$RID|" \
  /root/hivemind/infra/docker-compose.hetzner.yml
cd /root/hivemind/infra && docker compose -f docker-compose.hetzner.yml \
  --env-file ../.env up -d --no-deps core

# frontend — NOT the first `hivemind/fe` match; lines above it are -b2b / -b2c
cd /root/hivemind-next/infra && docker compose -f docker-compose.next.yml \
  --env-file ../.env.embedding-canary-runtime up -d --no-deps frontend
```

`--env-file ../.env` resolves relative to CWD — run from `infra/` or it looks for
`/root/.env`. The next project needs `.env.embedding-canary-runtime` for
`NEXT_VERSION` and `NEXT_QDRANT_API_KEY`.

Then prove it with the code, not the tag:

```bash
docker exec hm-core sh -c 'grep -c "<a string from your diff>" /app/src/<file>'
```

Also: the script's acceptance gate greps `fe:$RID-single` with an 8-char SHA while
tags in use are 12-char, so it prints `FATAL: frontend not on <RID>` after a
**successful** build. A FATAL there is not proof of failure.

---

## 10. Open

- ~~`release-singulance.sh` does not update the compose tag~~ — **fixed
  2026-08-07**: `settag()` now rewrites the compose image line per-service before
  recreate, and `recreate()` asserts `docker inspect --format '{{.Config.Image}}'`
  matches the RID after the health gate. See §9.1 for the procedure this replaced.
- ~~Governance daily token budget needs an owner~~ — **superseded 2026-08-07**:
  the global `__pool__` row was the wrong unit (no `org_id` column on
  `governance_agent_state`, so it serialised every tenant against one budget).
  Design for the per-org replacement is in `COGNITION_V2_PLAN.md`; not yet built.
- 3 of 15 slides find no unique anchor and stay `null` (§5.2). Moot if §11 lands —
  anydoc carries no page provenance at all, so this only matters while docling
  still owns pptx.
- `[enterprise-extract] LLM call with no org context` — unattributed calls,
  a metering gap. Still open.
- `/v1/orgs/:id/profile` returns 404; `Profile.jsx` swallows it with
  `.catch(() => null)`. Still open.
- The `Extends`/`Contradicts` edge classifier under-fires on chat saves — see
  §5.4. `MEMORY_PROCESSOR_DEBUG=true` is currently ON in production for this
  investigation; turn it off once the third edge-writer is found.

## 11. `firecrawl/anydoc` — replaces docling for office formats, not for pages

Evaluated 2026-08-07 against the same corpus and ground truth as §2–§4, small and
large files (`~/anydoc-eval/`, 22 documents). In-process Rust binding, no sidecar,
no OCR models, no LibreOffice dependency.

| file | anydoc | docling |
|---|---|---|
| 92-page / 47MB PDF | **141ms**, 96.6% recall | 128,900ms, 99.0% |
| 67-page PDF | **212ms**, 95.5% | 147,800ms, 78.3% |
| 52-page PDF (the one that 504'd on sync) | **148ms**, 95.7% | needed async, 94.6% |
| 20MB pptx, 17 slides | **37ms**, 100% | 11,800ms |
| docx / xlsx | 1–6ms, 99–100% | 80ms–2s, 99–100% |
| 3-page scan | clean `unsupported` (no OCR) | fake `success`, 46 chars |

Recovered both strings docling silently dropped on the reference deck (`Seed
Deck · August 2026`, `Stabile Temperaturschichtung`) and all five donut figures
on `BundB-Solvis-Budget.pdf` that fast-pdf had flattened.

**The blocker: zero page/slide markers, on every one of the 22 documents
tested.** No `<!-- page N -->`, no `-- N of M --`, no slide separator of any
kind. `toDocument` (where provenance might live in the Rust model) throws
`Failed to create reference from TypedArray` on every input on macOS arm64,
including a 19KB docx — not yet tested on Linux/container.

Decision, given quota no longer needs parser page numbers (`countPages()` in
§4.2 already reads the container directly, independent of any parser):
- **docx / xlsx / legacy `.doc .ppt .xls .rtf .odt` → anydoc.** docling gives
  `pages=0`/`texts=0` for these today, so nothing is lost, and this unblocks the
  legacy binaries KB_EXTENSIONS currently refuses for lack of LibreOffice.
- **pptx / pdf → keep docling** unless/until §5 citation requirements are
  formally dropped, in which case anydoc can take these too and the docling
  sidecar (9GB, 3 workers) is deleted entirely.
- **scanned PDFs → vision**, unchanged either way.

Not yet built: `hm-extract`, a standalone stateless service wrapping anydoc.
Contract, seam rationale (parse+chunk moves out at 14% of ingest wall-time;
promotion — 82% — stays in core because that is where tenant/residency logic
lives) and test plan are in `~/anydoc-eval/HM_EXTRACT_SPEC.md`, not yet copied
into this repo.
