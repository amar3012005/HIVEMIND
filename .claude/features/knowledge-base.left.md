# Knowledge Base — what I left unfinished

Written per Gate 3 (`CLAUDE.md`). Session 2026-08-01. The parse and capture chain
is fixed, deployed in a pinned image, canary 6/6 — see `knowledge-base.md`. These
seven items are NOT done, and the feature must not be marked `[x]` until they are.

---

## 1. Figure descriptions produce nothing
**Evidence:** `select count(*) filter (where content ilike '%image%' or '%diagram%'
or '%chart%')` over `solvisD.pdf`'s 63 segments returns **0**. Yet `convert` and
`pdftoppm` are present in the running image (verified `command -v`), the PDF coder
policy is `read|write`, and the parse now reaches the enrichment block with
`smart=true`.
**Why it was left:** ran out of context. Three prerequisites were fixed in
sequence this session (renderer install, smart routing, Docling resourcing) and
each revealed the next; this is the fourth layer and I did not get to trace it.
**Who it hurts:** every chart, diagram and figure in every PDF is silently
discarded. On the customer's own 54-page deck that is the EV-adoption curve, the
heating-market collapse, the 1986→2026 product timeline and the 35/30-40/20/5%
partner split — none of which exist as text anywhere in the document.
**Next step:** confirm whether `do_picture_description` is actually being sent in
the Docling form-data (`docling-adapter.js` ~line 85, inside `if (smart)`), then
whether the response carries picture annotations that segmentation is dropping.
Log the raw Docling response keys for one page before changing anything.

## 2. Language leak — German document, English memories
**Evidence:** `solvisD.pdf` is entirely German; its memories read *"Germany is
electrifying its energy system due to societal, ecological and economic
reasons…"*. Earlier runs of the same file produced German. Non-deterministic.
**Why it was left:** found in the final verification pass with no context left to
fix it.
**Who it hurts:** a German enterprise tenant gets memories they cannot quote back
to their own stakeholders, and recall in the source language degrades. This is a
correctness defect, not cosmetic.
**Next step:** the extraction prompt does not pin output language. Pin it to the
detected source language of the segment rather than letting the model choose.

## 3. Duplicate memories within one document
**Evidence:** `solvisD.pdf` stored *"Home Energy Management Systems (HEMS) like
E3DC Hauskraftwerk / One, Fenecon Home 10, and Huawei's EMMA-A02…"* twice in the
same run. Earlier, `solvis5.pdf` duplicated a claim whose source pages (2 and 3)
are byte-identical in the PDF.
**Why it was left:** lower value than the parse chain, which was blocking
everything else.
**Who it hurts:** duplicate claims inflate counts, waste recall slots, and make
the corpus look padded to anyone auditing it.
**Next step:** semantic dedup correctly suppressed canary repeats, so it works
across documents. Check whether intra-document candidates bypass it — likely they
are compared only against PRIOR memories, not against siblings in the same batch.

## 4. Four production guardrails never tested
**Evidence:** `knowledge-base.md` marks AuthZ, input validation, idempotency and
observability `[ ]`. No probe was ever run for any of them.
**Why it was left:** the parse chain consumed the session. These are *untested*,
not known-broken — I will not claim either way.
**Who it hurts:** unknown, which is the problem. For an enterprise B2B tenant,
"we never checked whether a wrong-org caller can read your documents" is not an
acceptable answer.
**Next step:** AuthZ first — mint scoped keys for two orgs, upload to A, attempt
every `/api/knowledge/*` read with B's key, intersect the ID sets. This is Gate 2
and it is the single reason this feature cannot be marked done.

## 5. ~46% of tenants cannot be verified at all
**Evidence:** `organizations.memory_storage_mode` — 6 orgs `amr_embedded`, 1
`byod_amr`, 6 `hybrid`. Observed on boozit (`40da0836`): ingest logged
`✓ doc=689f15da segs=1 promoted=2` while every Postgres table was legitimately
empty.
**Why it was left:** asserting against the `.amr`/mneme store is unbuilt work, not
a fix — it needs its own design.
**Who it hurts:** almost half of tenants have no ingest verification whatsoever.
The canary now names the mode instead of failing blind, but it still cannot check
them.
**Next step:** teach `artifacts/memory-ingest-canary.py` to read
`/app/data/mneme/<orgId>/` for `amr_embedded` orgs and assert the same six
invariants there.

## 6. Legacy corpus stranded, no re-extract endpoint
**Evidence:** ~65 documents ingested before `295594e54` have no retained source
text. New uploads retain (verified: 25,576 chars).
**Why it was left:** needs a new endpoint; every other item was a fix to existing
code and took priority under the modify-don't-add rule.
**Who it hurts:** none of this session's sixteen fixes reach a single existing
document. Every future extractor improvement will have the same problem.
**Next step:** build re-extract over `source_artifacts.payload.content` — this is
now possible and was not before. Gate it on `processing_version` so it is
idempotent and resumable.

## 7. Deploy divergence risk (process, not code)
**Evidence:** the core compose tag changed under this session twice while other
sessions worked the same box; one `compose up` silently reverted instrumentation
I had `docker cp`'d.
**Why it was left:** it is a coordination problem, not a code defect.
**Who it hurts:** any fix that reaches production via `docker cp` and is not baked
into an image disappears at the next restart, with no warning and no log.
**Next step:** already mitigated for this feature — `infra/Dockerfile.core-kb-complete`
overlays only this session's files onto whatever image is live, preserving other
sessions' work. Use that pattern; do not full-rebuild from a shared tree.

---

**Also outstanding, not feature-scoped:** 23 commits unpushed —
`git push origin codex/tara-grok` is classifier-blocked for the assistant and
needs the owner.
