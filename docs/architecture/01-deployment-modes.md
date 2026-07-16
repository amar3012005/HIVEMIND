# 01 — Deployment modes

Three ways a tenant's data is hosted. The engine + frontend are identical in all three; only the
storage backend for that org's memory differs.

## Mode A — Managed (default, the original version)
Everything central, on our box. No change from the pre-`.amr` system.
```
our box:  control-plane · core · employees · tara · docling · nango · hermes · FE
          + central Postgres (everything) + central Qdrant + redis
```
- All memory + all global info in our central Postgres + Qdrant.
- Selected when: org has no self-host registration (the default).

## Mode B — Self-host HYBRID (full data residency)
The customer runs **only their data** — Postgres + Qdrant — on their box. Our engine reaches them
through an outbound tunnel. Engine, control, FE stay central.
```
our box:    full engine + control + FE + ONE global Postgres (all user/org/key info)
customer:   Postgres (memory subgraph) + Qdrant (vectors) + outbound tunnel
```
- **memory subgraph** (14 tables) + **vectors** → customer's box.
- **global info** (User/Organization/ApiKey/memberships/billing/settings) → central Postgres.
- Selected when: org registered a `pgUrl` + `qdrantUrl` (no agent URL).

## Mode C — Self-host `.amr` (single-file memory)
Like B, but the customer's memory is a single **`.amr` file** (vectors + graph + layers) instead of
Qdrant, served by a small `hm-agent`. Postgres still on the customer box for the relational subgraph.
```
customer:   Postgres (subgraph) + .amr file (vectors+graph) + hm-agent (serves recall) + tunnel
```
- Selected when: org registered an agent `url` (hm-agent HTTP). `orgIsRemote=true` → recall marshalled
  to the agent (`remote` driver mode).

## What is GLOBAL vs PER-TENANT
| Data | Where | Why |
|------|-------|-----|
| User, Organization, ApiKey, memberships, billing, settings | **ONE central Postgres** (all modes) | "data information" — identity/control; the FE + auth + billing need it central |
| Memory subgraph (memories, relationships, segments, entity links, …) | central (A) / customer PG (B,C) | the tenant's actual memory content |
| Vectors | central Qdrant (A) / customer Qdrant (B) / customer `.amr` (C) | recall index |
| Typed graph (edges) | with the vectors (Qdrant→PG relationships, or `.amr` `.edg`) | relationship recall |

## Feature parity
All features run in **all three modes** — the engine code is unchanged; only `getPrismaClient()` /
the vector base resolve per-org. Verified: managed recall/ingest intact after every change; PQC signing,
tenant-isolation middleware, HyperAgents, cognition, dreaming all unmodified.

## Selection logic (per request/job, in core)
```
org has agent url   → Mode C (.amr remote)      orgIsRemote(org)=true
org has pgUrl        → Mode B (hybrid)           clientForOrg(org) → split client
neither              → Mode A (managed)          central client
```
Resolved inside `runWithOrg(orgId, …)` context; see 02.
