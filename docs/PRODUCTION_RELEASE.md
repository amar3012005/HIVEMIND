# Production Release Ledger

## 2026-07-14 - Exact Evidence Segment Binding

- Release: `prod-20260714-0edec7e9`
- Source: `codex/ingestion-production-reconcile@0edec7e9`
- Scope: `hm-core` only; no frontend, control-plane, data service, employee, broker, or TARA rebuild.
- Image: `sha256:26a62545b1e518194b59d2f732d6dcca6f57aba81ab5a11653995d2846cdfa73`
- Rollback: `hivemind/core-api:rollback-20260714-pre-7c30d58a`

Acceptance:

- Linux focused tests: 27 passed, 0 failed.
- Re-windowed extracted claims now resolve their exact quote back to the persisted evidence segment instead of assigning segment IDs by window index.
- Document-level curation preserves the primary extraction window while retaining every supporting segment and quote for merged memories.
- Public health: PostgreSQL, Qdrant, and Docling reachable; evidence recall, document-first ingest, and entity extraction enabled.
- Runtime: healthy, zero restarts, no fresh fatal, uncaught, panic, or OOM log entries.

Pending controlled proof:

- Clear FOREST memories, upload one representative document, and audit raw document, segments, durable memories, evidence links, entities, typed relationships, recall, and chat before uploading the remaining corpus.
- Native `.amr` and live BYOD parity remain a separate release gate and are not claimed by this deployment.

## 2026-07-14 - Source-Grounded Ingestion Admission

- Release: `prod-20260714-7c30d58a`
- Source: `codex/ingestion-production-reconcile@7c30d58a`
- Scope: `hm-core` only; control-plane, frontend, data services, employees, BYOD broker, and TARA were not recreated.
- Stable image: `sha256:c5154bd66e05708a6b51bc774d1d4def4ba7c989a040c94e1d1dfab0fd09f35f`
- Rollback: `hivemind/core-api:rollback-20260714-pre-7c30d58a`

Acceptance:

- Linux image tests: 29 passed, 0 failed.
- Synthetic managed-FOREST upload: five durable memories plus one bounded document summary.
- Provenance: five exact evidence excerpts and five structural `PartOf` edges.
- Entities: only `FOREST`, `Atlas`, and `Mira Chen` were linked.
- Recall: CSS/markup durable-memory noise suppressed while raw evidence remains available.
- Tenant-scoped probes: Mira Chen decision 367 ms; escalation context 1.63 s; combined summary plus evidence 2.16 s.
- `/api/chat`: correct contract value and discount approver, grounded with six sources.
- Cleanup: synthetic document, memories, evidence links, and relationships all verified at zero.
- Runtime: healthy, zero restarts, no fresh fatal/uncaught/OOM log entries.

Residual proof boundary:

- Managed PostgreSQL plus Qdrant is production-proven by this release.
- Native `.amr` and live BYOD ingestion parity were not exercised in this acceptance run.
