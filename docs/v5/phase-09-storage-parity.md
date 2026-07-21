# Phase 9 — Storage/Backend Parity   ⬜ NOT STARTED (needs disposable .amr/BYOD targets)
## Envisioned state
Qdrant stores vectors + canonical ids + filter metadata ONLY (candidate retrieval);
PostgreSQL/.amr owns canonical truth. Identical semantic contracts across managed,
.amr and BYOD. Resumable reindex, source versioning, evidence retention, archived-
vector cleanup, tenant export, verified hard delete (removes unsupported memories/
evidence/vectors WITHOUT deleting the BYOD service).
## Acceptance (real cURL)
Same fixture suite vs managed PG/Qdrant AND disposable .amr AND BYOD → identical
recall+graph; restart each backend → identical results.

## STATUS 2026-07-21
Infra-verification phase. Managed PG/Qdrant path is the strongest + exercised all session.
.amr + BYOD parity needs disposable test targets not available in this env; deferred to an
infra cycle with those targets. Qdrant-as-candidate-only + hard-delete purge are the code items.
