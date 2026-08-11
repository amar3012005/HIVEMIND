# HIVEMIND Architecture

How the system is built — the engine, the storage driver, the deployment modes, and the BYOD
data-residency design. Written 2026-06-26 after the `.amr` + per-org-storage work.

## The one idea
**The engine is fixed; only *where a tenant's data lives* varies.** The frontend talks to the same
central engine for every customer. Deep at the data layer, each org's storage is resolved per-org —
central for managed orgs, the customer's own box for self-host. Nothing above the data layer changes,
so **every feature works in every mode** (recall, HyperAgents, cognition, dreaming, connectors, PQC).

```
FRONTEND ──► ENGINE (control-plane + core)          ← SAME API for ALL orgs
                  │
                  ▼  per-org storage resolution (the ONLY thing that varies)
        managed   → central Postgres + Qdrant
        self-host → customer Postgres + Qdrant (hybrid)   OR   customer .amr + Postgres
```

## Documents
| # | doc | what |
|---|-----|------|
| 01 | [deployment-modes.md](01-deployment-modes.md) | managed vs self-host (hybrid / `.amr`); what runs where; what's global vs per-tenant |
| 02 | [storage-driver.md](02-storage-driver.md) | the driver seam, `.amr` engine, dual-write, the per-org split client, `runWithOrg` |
| 03 | [byod-data-residency.md](03-byod-data-residency.md) | the full self-host flow — enroll/register, tunnel, schema bootstrap, URL map |
| 04 | [pipeline.md](04-pipeline.md) | ingestion + recall + typed graph + PQC; where per-org routing applies; what's unchanged |

## Two invariants
1. **One global Postgres** holds all user/org/key/billing/settings info for **every** user (managed
   and self-host), exactly like the original version. Only the **memory subgraph** (+ vectors) can move
   to a customer box.
2. **FE→engine requests never change.** The per-org split is `engine→data` only.

## Related
- `CHANGELOG/2026-06-26-mneme-amr-engine.md` — the `.amr` engine + driver arc.
- `docs/BYOD-ARCHITECTURE.md` — the earlier recon + no-leak production plan.
- `infra/` — clone-and-run for a fresh box. `byod/` (+ `byod` branch) — the customer data bundle.
