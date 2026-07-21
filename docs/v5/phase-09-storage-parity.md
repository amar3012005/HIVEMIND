# Phase 9 — Storage, Lifecycle & Backend Parity   ⬜ NOT STARTED
## Envisioned state
Qdrant stores vectors + canonical ids + filter metadata ONLY (candidate retrieval);
PostgreSQL/.amr owns canonical truth. Identical semantic contracts across managed,
.amr and BYOD. Resumable reindex, source versioning, evidence retention, archived-
vector cleanup, tenant export, verified hard delete (removes unsupported memories/
evidence/vectors WITHOUT deleting the BYOD service).
## Acceptance (real cURL)
Same fixture suite vs managed PG/Qdrant AND disposable .amr AND BYOD → identical
recall+graph; restart each backend → identical results.
