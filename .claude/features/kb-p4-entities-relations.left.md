# P4 — entities, relationships, memory enrichment (upload path ONLY)

Owner directive 2026-08-03: restore previous-version entity robustness, enrich memories
beyond 1–2 lines with subject/heading (`filename : heading` acceptable), keep
confidence/importance scoring robust, add semantic relationships
(Updates/Extends/Contradicts/Derives). DO NOT touch single-image, meetings, save_memory,
connectors — they are good and need only the semantic relationship types.

## Verified findings (this session, live DB)

1. **memory_entity_links → entities is severed DATABASE-WIDE.**
   `exists(entities e join memory_entity_links el on el.entity_id=e.id)` = **false**.
   Every entity_id in the links table is a phantom. The graph is not starved — the FK
   target rows were never created.

2. **THE FIX ALREADY EXISTS AND IS UNWIRED.** `core/src/memory/canonical-entity-persister.js`
   — `persistCanonicalLinks({...})` using `EntityResolver` (exact canonical reuse scores
   0.93, AUTO_LINK_FLOOR 0.95, fuzzy → review queue, else create) + `normalizeEntityKind`.
   **Zero call sites.** This is the previous version's "great and robust" entity path,
   built and then orphaned. Wire it where the upload path currently writes
   memory_entity_links / entity tags (document-first-ingestion.js, `entityTags` around
   the `fact.entities` map in `_ingestUnifiedWindow`), do NOT write a new resolver.

3. Entity tags show the dedup gap the resolver solves: `wärmepumpe` vs `wärmepumpen`
   as separate entities; `eautos`.

4. **Relationships: only PartOf (26) for the latest doc.** No semantic edges anywhere on
   the upload path. Schema enum already has Updates/Extends/Derives/Contradicts/PartOf/
   Mentions — writers absent.

5. **promote=325s of 398s** — `for (const claim of curated)` persists 27 claims
   SEQUENTIALLY (each: embedding + entity pass + dedup + writes). Fix: bounded
   concurrency ~4, but READ THE DEDUP PATH FIRST — per-claim dedup may depend on prior
   inserts; naive parallelism writes duplicates.

## Order of work (one commit each, PDF-upload smoke + recall canary after every deploy)

1. Wire `persistCanonicalLinks` into `_ingestUnifiedWindow`'s entity handling → Entity
   rows actually created, links real, normalization + review queue live.
   Gate: `entities ⋈ memory_entity_links` non-empty; `wärmepumpe(n)` → ONE canonical.
2. Memory enrichment: prefix content with `«docTitle : heading»` context (or keep title
   field but include heading), 2–4 sentence target instead of 1, keep source_quote gate.
   Confidence/importance: carry the extractor's per-fact confidence into the memory row
   (it is currently dropped after minImportance was zeroed) — restore scoring fields,
   don't restore the GATE.
3. Semantic relationships 5b: ONE call per doc over the atomic fact list →
   Updates/Extends/Contradicts edges with source quotes; Derives marked inferred=true,
   barred from citation, excluded from supersession. Reuse relationship enum, write via
   existing relationship model (routed for .amr already).
4. Persist-loop concurrency (the 325s).

## Standing state
live `sha-566dcff73` healthy; singulance-main == live; canary 5/5; PDF smoke green.
Worktree: /tmp/mt (clean, at HEAD). Probe files: /tmp/deck.pdf (54p reference).
Key for org 1380251c: hmk_live_f6c78d7b9f48dd32842d0b00ee047a774a09b8d61d2d4efb.
