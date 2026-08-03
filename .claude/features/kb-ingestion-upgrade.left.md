# LEFT — KB ingestion / recall upgrade (recon 2026-08-03)

Verified against the LIVE image `hivemind/core-api:prod-20260803-tara-closed-loop-aba89340`.
All 12 KB markers confirmed present in the running container (sheet-direct, FORMAT_PROFILES,
usableChars, KB_SEMANTIC_SEGMENTS, ENTITY_EXTRACT_MAX_TOKENS, retained_at, kb-tables,
kb-curate, IMAGE_NOT_A_DOCUMENT, duplicate:true, precheck, hivemind_query_table) — the KB
work survived the TARA deploy. What follows is what is NOT done.

Live env at time of recon (differs from code defaults — this matters):
    KB_UNIFIED_DOC_CAP=24          (code default 30)
    KB_UNIFIED_WINDOW_CHARS=2500   (code default 1500)
    KB_FACTS_PER_1K_CHARS=6        (code default 12)
    KB_UNIFIED_MIN_IMPORTANCE=0.65
    KB_CURATED_MEMORY_CAP=0        (the =8 defect IS fixed)

---

## A1. The document budget silently discards ~80% of every long document
**Evidence:** `document-first-ingestion.js` ~3270:
`while (wi < uWindows.length && uBudget > 0)` with `let uBudget = DOC_CAP`.
Live: 62,867-char deck ÷ 2500 = ~25 windows; per-window grant
`min(UWMAX=10, round(2.5 × 6)=15)` = 10; budget 24 is reserved by ~3 windows and
stretches to ~4–5 windows of real yield via `uBudget += grant - got`. Windows ~6–25
are **never sent to the LLM**. There is no log line recording the drop. Measured
consequence: 18 memories from 62,867 chars, and `_dynamicCap = min(30, max(8,
ceil(24×0.7)=17))` reconciles exactly — the ceiling was the budget, not the document.
**Why it was left:** found only in this recon. I previously attributed the 18-memory
ceiling to `KB_CURATED_MEMORY_CAP=8` (real, and fixed) and then to "the curator's
judgement" (wrong). I never examined the window loop's exit condition.
**Who it hurts:** every tenant uploading anything longer than ~5 windows (~12k chars).
The tail of every contract, deck and report is invisible to recall and to the graph.
This is silent partial completion in our own hot path — the defect class CLAUDE.md
names unforgivable.
**Next step:** `DOC_CAP = clamp(round(chars/1000 * 1.2), 30, 400)`; emit
`[kb-unified] windows_total=N windows_processed=M budget_exhausted=bool`. Never exit a
document without a log.

## A2. `KB_FACTS_PER_1K_CHARS=6` in prod contradicts the code's own documented reason for 12
**Evidence:** live env = 6. Code comment above the constant: "8/1k throttled SHORT
dense sections: a 711-char window with 7 distinct facts was allowed only 6, and the
model returns conservatively under whatever ceiling it is given (told 6 -> returned 3;
told 10 -> returned all 7)."
**Why it was left:** I read the code default and never diffed it against the running
env. This is the `KB_CURATED_MEMORY_CAP=8` mistake repeated verbatim: I reasoned about
a constant without checking what production actually passes.
**Who it hurts:** halves extraction density on every dense section for every tenant.
**Next step:** remove the override (or set 12) and re-measure on the same deck.

## A3. Zero overlap between extraction windows
**Evidence:** `chunkText(fullText, { targetSize: UWIN, maxSize: UWIN*1.6, minSize: 250,
overlapSize: 0 })`.
**Why it was left:** never audited — I described window size and never its overlap.
**Who it hurts:** any claim whose subject sits in window N and predicate in N+1 is seen
whole by neither. This is mechanically the `"Fehlende Elektro-Kompetenz"`-with-no-owner
defect.
**Next step:** `overlapSize: 200` (segments already carry 120).

## A4. `heading: null, page: null` hardcoded in TWO places
**Evidence:** window construction (~3255) and the persist path's `sourceWindow` (~3311).
So `_extractUnified` genuinely receives window text + `docTitle` only.
**Why it was left:** I had asserted this as an inference from prompt shape; only now
verified as literal hardcoded nulls in two locations, so a fix in one place would have
been a silent no-op — the same shape as the `smartOpt !== false` no-op earlier.
**Who it hurts:** subject-less claims, and `importance` scored blind.
**Next step:** pass heading hierarchy path + page + a one-line document summary into
every window; delete both null pairs.

## A5. Positional `segmentId` guess mis-attributes evidence
**Evidence:** `segmentId: promotableSegments[Math.min(i, promotableSegments.length - 1)]`.
Segments are 700 chars, windows 2500 — ~3.5× more segments than windows, so window *i*
does not correspond to segment *i*, and `Math.min` clamps every overflow onto the LAST
segment.
**Mitigation that exists:** `resolveEvidenceSegment(claim.source_quote, ...)` re-resolves
by substring and saves most cases. Unmitigated whenever the quote does not match.
**Why it was left:** not previously examined.
**Who it hurts:** a citation that points at the wrong paragraph, silently.
**Next step:** resolve by character offset; log the fallback count.

## A6. `MIN_IMPORTANCE=0.65` gates on a score produced without context
**Evidence:** live env `KB_UNIFIED_MIN_IMPORTANCE=0.65`; importance is assigned by the
LLM from a window with no heading, page or document context (A4).
**Why it was left:** only connected to A4 in this recon.
**Who it hurts:** real claims discarded on a blind score.
**Next step:** fix A4 first, then re-tune. Do not tune the threshold before the input.

## B1. The document is chunked THREE times, none aligned
Docling HybridChunker (discarded by default), semantic segments 700+120, extraction
windows 2500+0.
**Why it was left:** each was added for a good local reason; nobody unified them.
**Next step:** segment ONCE from Docling's clean markdown carrying heading path + page;
a window becomes N contiguous segments, so provenance is exact by construction.
**Correction on record:** do NOT simply flip `KB_SEMANTIC_SEGMENTS=false` to use
Docling's chunks. The gate's comment (~2805) documents a measured defect — hybrid chunk
text starts/ends MID-WORD. Confirmed in old segments: `"th labels like"`,
`"ts a heat pump"`, `"nschluss an SolvisMax"`, `"visBruno7kW"`. Take hybrid's
BOUNDARIES + METADATA, not its text edges.

## B2. Double Docling conversion
**Evidence:** `server.js:1862 parseWithDocling` and `:1868 chunkWithDocling` inside one
`Promise.all`; both perform a full convert; the chunker's output is discarded whenever
`KB_SEMANTIC_SEGMENTS` is on (the default).
**Why it was left:** found and confirmed, then queued behind the deploy race with the
parallel sessions. No code change was made.
**Who it hurts:** doubles Docling cost and latency for every tenant, and keeps two
failure modes alive (`chunkerError`, the 180s chunker abort).
**Next step:** remove `chunkWithDocling` from the default path.

## B3. `segment_type` is hardcoded `'structured'`; `heading` is null on most rows
**Evidence:** live segment metadata `{"source": "semantic_chunk", "heading": null}`;
`segmentType: 'structured'` literal in BOTH the semantic and hybrid branches.
**Next step:** honest types (`table` / `heading` / `paragraph`) + populate heading.

## C1. Entity canonicalization + backfill
**Evidence:** 2,176 entities, 1,229 with zero mentions (56%);
`hannover`/`germany`/`berlin`/`europe`/`uwe berger` each hold 4 duplicate rows.
**Why it was left:** blocked on the owner's corpus re-upload (P0 in the chat plan).
`hivemind_aggregate_entities` and graph traversal are built and starved.
**Next step:** canonicalize at write time against the org's existing entities, then
dedupe/backfill.

## C2. No typed relationships
Edges are derived deterministically from shared non-common entities; no LLM asserts an
edge.
**Next step:** typed extraction gated by the same `content.includes(item.source_quote)`
proof already required of claims.

## D1. Tier-2 deferral never built
`_distillFactsAsync` exists only inside a comment. Measured: parse 48s + seg 17s +
embed 17s = 82s to searchable, then promote 76s.
**Why it was left:** deferring promotion requires the FE to render an "enriching" stage
and a zero-memory gate first, or a good ingest renders as **Failed**.
**Next step:** E4 then D1.

## E. Frontend (KnowledgeBase.jsx)
- **E1** "Clear completed" button missing — the user asked for it explicitly.
- **E2** list churn / fluctuation during a batch.
- **E3** a zero-memory ingest renders as success, not as an outcome.
- **E4** no "enriching" stage — blocks D1.
**Why left:** deprioritised under the deploy races; none is blocked on backend work.

## F. Recall
- **F1** evidence-lane context caps never audited. `CHAT_TOP_MEMORY_CHARS` was raised to
  8000, but chat also grounds on `knowledge_segments` and that lane's cap was never
  measured.
- **F2** phrasing sensitivity: the same memory is found for `"HEIDELBERG charging
  station"` but not for a German paraphrase; a bare entity name returns zero sources.
- **F3** ~65 legacy documents are unrecoverable. Source retention shipped (295594e54)
  but only applies to NEW uploads; there is no re-extract endpoint.
- **F4** route `"my <strategy>"` (singular) to the profile lane.

## G1. LIVE REGRESSION I CAUSED — the HyperAgents leads page is dark
**Evidence:** `docker exec hm-employees env | grep HYPER_PROSPECTS` → unset, so the
write-guard is active. `list_prospects` (`agentscope_tools.py:1389`) queries
`{"tags": "prospect", "is_latest": "true"}` — it recalls MEMORIES; there is no leads
table anywhere in the schema.
**Why it was left:** I shipped the guards (`3ab5356db`, `33f461eb9`) to stop CRM records
polluting semantic recall. Stopping the leads page was an unintended side effect I
flagged in the plan but never remediated.
**Who it hurts:** the 115 existing rows still render; every prospect discovered since
those commits is invisible.
**Next step:** set `HYPER_PROSPECTS_TO_MEMORY=true` to restore the page NOW, then build
the typed leads table (plan P5) and repoint `list_prospects`.

## G2. Chat plan status
- P1 `hivemind_count_where` — LIVE (verified in the running image).
- `isCountQuery` — LIVE (verified), but P2 is still **regexes**, not the classifier the
  plan specifies. German/English parity is by hand-listed markers.
- P3 tabular lane — SHIPPED and verified live (`sheet=Tabelle1 row_count=43 cols=5`).
- **P4 NOT DONE** — answers do not declare how they were obtained
  (`sampled(k=5)` vs `counted(complete=true)`). This was the trust guarantee.
- P0 / P5 — see C1 and G1.

## G3. The live image is a label tag, not a SHA
`prod-20260803-tara-closed-loop-aba89340` violates the rule written into CLAUDE.md this
session ("tag images by commit SHA"). The SHA is embedded, so it is recoverable, but the
convention is not being enforced by the deploy path yet.

## G4. Six frontend branches unmerged into `main`
`india`(9), `europe`(9), `codex/singulance-01-chat-clean-language`(7),
`release/kb-final-20260802`(6), `codex/meeting-notes-ui-final-20260802`(5), `master`(4).
The one-clean-branch model was applied to the backend (`singulance-main`) and agreed for
the FE, but the merge was never completed.

## G5. Repo root littered with ~40 untracked control files
`.last-*-rollback`, `.*-build.exit`, `.campaign-v2-*-tag`. Harmless individually; they
make `git status --porcelain` noisy, which is exactly the signal `preflight-deploy.sh`
depends on.

## G6. HQ Runtime is live in production and fully untracked
Exists only in `/root/hivemind-main`, in no git tree. Armed TDZ crash at
`native-engine.js:122` kills every `work_result` cycle.

## G7. The working tree is dirty
Modified and uncommitted: `core/src/agent/toolkit-factory.js`,
`core/src/tara/stream-handler.js`, `employees-service/.../agentscope_tools.py`,
`employees-service/.../hyper/engine.py`, `infra/docker-compose.hetzner.yml`, plus docs.
By design this blocks `preflight-deploy.sh`, so it blocks every item above from shipping.

---

## Fix order

1. **G1** — one env flip, restores a dark production page. Seconds.
2. **A2** — one env flip, doubles extraction density. Seconds.
3. **A1 + A3 + A4 + A5 + A6** — one file, one commit. The yield fix.
4. **B2** — delete the second Docling convert.
5. **B1 + B3** — one chunking, metadata-aware.
6. **C1** — entity canonicalization + backfill.
7. **C2** — typed grounded relationships.
8. **E1–E4** — frontend honesty + the enriching stage.
9. **D1** — Tier-2 deferral (needs E4).
10. **F1–F4** — recall audit.
11. **G2–G7** — P4 mode declaration, then hygiene.

Gate: G7 must be resolved before step 3 can ship, because the deploy refuses a dirty tree.
