# Robust semantic chunking — plan

Follows [`contextual-embed-input.js`](../core/src/knowledge/contextual-embed-input.js) (shipped
`ec130d62`), which anchors each chunk to its document/heading at embed time but does not change
WHERE chunks are cut. This plan covers the cut itself.

Current state: `chunkText()` in `document-chunker.js` splits at structural boundaries only
(heading / paragraph / sentence), target ~700 chars, 120-char overlap, no embedding-similarity
boundary detection. Meta-aware (heading_path, page, segment_type, scope) since before this plan;
semantic-boundary-aware not yet built.

---

## 0. Eval first — build before anything else changes

No chunking change can be judged without this. Seed documents with facts placed at known
positions (including straddling a paragraph break), chunk, retrieve, assert:

- each seeded fact survives as ONE retrievable unit (not split across chunks)
- count of facts requiring 2+ chunks to answer
- chunk-count delta vs. the current chunker on the same corpus

Hang it on the existing `core/scripts/eval-harness.mjs` / `eval-gate.mjs`. Every threshold below
is a quality/cost tradeoff that only this can settle — without it we are tuning by vibes on a
~23-segment corpus, which cannot distinguish a real improvement from noise.

## 1. Boundary signal

Sliding sentence windows (2-3 sentences — single sentences are too noisy), cosine similarity
between adjacent windows, split at local minima.

- **Per-document percentile threshold**, not a global constant. A dense contract and a slide deck
  have different similarity distributions; a fixed threshold overfits one and destroys the other.
- **Smooth** the similarity series before thresholding, or every dip becomes a split.
- **Minimum run length** between splits, so the pass cannot produce 12-word chunks.

## 2. Structure is a hard constraint, not a suggestion

Semantic splitting operates WITHIN a structural unit, never across one. Heading boundaries, PDF
pages, and PPTX slides are hard boundaries; the semantic pass may split a section further, never
merge two sections.

This is also the fix for the measured PPTX defect (4 of 9 segments with NULL start_page on the
2026-08-06 upload test): slide = hard boundary repairs the page-attribution gap and the quota
undercount at the same time, since both trace back to weak structural anchors on slide decks.

## 3. Atomicity

Tables, list groups, and code blocks must never split. `_createSegments` already DETECTS
`segment_type: 'table'` (pipe-row heuristic) — that detection needs to become a boundary
CONSTRAINT, not just a label on the output. Documented failure mode already observed: a 7-row
compatibility matrix landing inside one segment reached the extractor as pipe-delimited text and
came back with 3 rows dropped.

## 4. Size guards apply AFTER the semantic pass

min/max enforced post-hoc. Similarity boundaries happily produce both a 12-word chunk and a
6000-char chunk in the same document if left unguarded.

## 5. Determinism + caching

Same document must chunk identically on re-ingest, or every re-upload churns the whole vector set.
Cache boundary decisions by content hash. At target scale (10M documents) this is a cost
requirement, not a nicety.

## 6. Selective application — the actual affordability lever

Only run the semantic pass when structural boundary density is low (few headings relative to
length). A well-headed document already chunks cleanly; embedding every sentence window on it
buys nothing and costs real money. This one gate is what keeps embedding cost from scaling
linearly with corpus size.

## 7. Degrade, never fail

Embedding call fails at chunk time → fall back to structural chunking, mark the segment
`boundary_source: 'structural_fallback'`. An upload must never fail because the boundary
detector's embedding call was unavailable.

---

## The real engineering cost

`chunkText()` is synchronous today. Embedding is a network call, so this signature change ripples
to every caller — that is the bulk of the implementation and regression risk, not the cosine math.

## Alternative worth measuring BEFORE building this

**Late chunking**: embed the full document with a long-context model, mean-pool token embeddings
per chunk region, keep boundaries structural. Every chunk inherits full-document context by
construction with no async chunker rewrite. `contextual-embed-input.js` (shipped) is a cheap
approximation of the same idea at the text level. Given that, measure late chunking against the
eval harness (step 0) BEFORE committing to the async boundary-detection rewrite (steps 1-2) —
it may deliver most of the win at a fraction of the engineering cost.

## Sequencing

0 (eval) → 6+2 (selective gating + hard structural boundaries — cheapest, fixes a measured defect)
→ measure late chunking against 0 → only then 1/3/4/5 if the eval says boundary detection still
wins over late chunking + the existing contextual prefix.

## Storage-mode scope

Whatever is built must sit in `_createSegments`, above the `orgIsRemote` branch, exactly where
`contextual-embed-input.js` was inserted — that is what made it apply to central, amr_embedded,
and byod_amr uniformly without three separate implementations.
