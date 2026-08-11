# 02 — Storage driver & per-org routing

The single seam where all backend-aware decisions live. Features are written against Prisma +
the vector store; this layer swaps what's behind them, per-org.

## Files
| file | role |
|------|------|
| `core/src/vector/mneme/driver.js` | the seam — flag parsing, per-org `.amr` stores, `isMnemeOrg`, `orgIsRemote`, `amrRecall/amrWrite/amrAddEdge`, `wrapPrisma`, `mnemeMode` |
| `core/src/vector/mneme/prisma-proxy.js` | model-routing proxy; exports `ROUTED_MODELS` (the 14 memory-subgraph tables) |
| `core/src/vector/mneme/remote-backend.js` | registry (`pgUrlFor`/`qdrantUrlFor`/`hasRemoteAgent`) + remote `.amr` marshalling |
| `core/src/db/prisma.js` | `getPrismaClient()`, `runWithOrg`, the per-org **split client** |
| `core/src/vector/qdrant-client.js` | per-org Qdrant base (`qbase()`) + `.amr` recall/write hook |

## `MNEME_MODE` — how `.amr` relates to Postgres (managed orgs)
- **`dual`** (default, production): Postgres keeps **every** row; `.amr` is an **additive** vector+graph
  index — it replaces *Qdrant*, not Postgres. Memory → PG row (as always) + `.amr` vector (write-hook) +
  `.amr` typed edge (`amrAddEdge`). Recall = `.amr` vector match → hydrate content from PG by id.
  HyperAgents + all relational features unchanged.
- **`sole`**: `.amr` is the ONLY store (PG=0) — the proxy routes the whole subgraph to `.amr`. Research/
  single-tenant.
- **`remote`** is decided **per-org** (not global): an org with a registered `hm-agent` (`.amr` on the
  customer box) → recall/write marshalled over the tunnel.

## The `.amr` engine (one file = a tenant's memory)
- Fixed-stride 202-byte slots: id, flags+layer, timestamps, PQ vector[128], entity bitmap, adjacency.
  Companion `.vec .txt .mnsw .edg` + JSON sidecars.
- 3 layers (evidence / memory / cognitive) in 2 flag bits — dreams/syntheses land in `cognitive`
  (`cognitive_layer_role` ⇒ layer). Recall filters/prioritises by layer.
- Typed graph in the slot adjacency: Mentions/Updates/Derives/Contradicts/PartOf/Extends.
- Persistent HNSW, crash-safe checkpoint, single-writer flock. A Prisma-compatible query engine over it
  (Path B) lets `.amr` be a relational store.

## Per-org Postgres — the split client (the key residency mechanism)
Full data residency keeps the **memory subgraph** on the customer PG while **global info stays central**.
```
db/prisma.js:
  runWithOrg(orgId, fn)      // AsyncLocalStorage — sets the org context for the duration of fn
  currentOrg()               // reads it
  getPrismaClient():
     ctxOrg = currentOrg()
     if ctxOrg has a customer pgUrl  → return SPLIT client:
            memory-subgraph models (ROUTED_MODELS) → customer PG
            User/Organization/ApiKey/$transaction/$queryRaw → CENTRAL PG
     else → central client (managed)
```
`makeSplitClient(central, customer)` is a Proxy: `ROUTED_MODELS.has(prop) ? customer[prop] : central[prop]`.
So a self-host org's **memory** writes/reads go to its PG; everything else (the "data information")
stays in the one global Postgres. The 35 `getPrismaClient()` call sites are **unchanged** —
AsyncLocalStorage carries the org.

## Per-org Qdrant
`qdrant-client.js`: `qbase() = qdrantUrlFor(currentOrg()) || QDRANT_URL`. Self-host-hybrid org → its
Qdrant (via tunnel); else central. The `.amr` orgs short-circuit to `amrRecall` before Qdrant.

## Where `runWithOrg` is entered (so nested `getPrismaClient` resolves per-org)
Re-entrancy guard at the data entry points that hold `orgId`:
`graph-engine.ingestMemory`, `queryPersistedMemories`, `recallPersistedMemories`,
`dreamProfilesForOrg`, `cognition runOnce`, `dreamRetentionForOrg`. Undefined org → central (managed).
*(Coverage note: KB-ingest + some connector paths still to wrap for 100% locality.)*

## Isolation guarantees (tested)
- self-host org → memory delegate = customer PG; `user`/`organization`/`apiKey` = central.
- managed org / no context → central for everything.
- `MNEME_AGENT_REGISTRY_FILE` unset → all routing inert (managed for everyone); zero prod impact.
