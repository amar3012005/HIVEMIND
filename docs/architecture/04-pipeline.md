# 04 — Ingestion & recall pipeline

The pipeline is **unchanged** by the storage work — same code for every mode. This documents it and
marks the single seam where per-org storage is resolved.

## Canonical ingestion (one path for ALL sources)
KB · connectors · `save_memory` (MCP) · chat autosave · web · dreams — **all** funnel through
`graph-engine.ingestMemory`:
```
ingestMemory(input)                    ← runWithOrg(input.org_id)  [per-org context enters here]
  ├─ build memory record (PQC-signed — signMemory in prisma-graph-store, in the engine)
  ├─ per-user advisory lock (serialise read-modify-write)
  ├─ RECALL latest + CLASSIFY relationship (the LLM relationship classifier)
  ├─ createMemory            → memory row  (split client → central PG or customer PG)
  ├─ embed → vector          → Qdrant/.amr (qbase / amrWrite → central or customer)
  └─ createRelationship      → typed edge  (PG row + amrAddEdge mirror; or remote)
```
- **Same LLM-generated relationships** for every source (one chokepoint: `memory/relationship-classifier`
  inside graph-engine), not per-connector.
- Relationship types maintained: Mentions / Updates / Derives / Contradicts / PartOf / Extends.
- Evidence-layer raw chunks (KB) write vectors only (no relationships) — by design; relationships belong
  to the memory/cognitive layers.

## Recall (vector + lexical + graph + layer-priority)
```
recallPersistedMemories / queryPersistedMemories   ← runWithOrg(org_id)  [per-org context enters here]
  ├─ vector match      → Qdrant (qbase) OR .amr (amrRecall)        → returns {id, score}
  ├─ lexical (FTS)     → Postgres to_tsvector  (split client → customer or central PG)
  ├─ graph expansion   → relationships.findMany (PG edges / .amr edges, by type)
  ├─ HYDRATE content   → memory.findMany by id (split client → customer or central PG)
  ├─ rerank / scope / cross-layer filter / promoted-segment exclusion / conflict-resolution
  └─ layer priority: cognitive (dreams/syntheses) → memory → evidence
```
**Content always hydrated from Postgres by id** (vector store returns ids+scores) — so for a self-host
org, the vector match comes from their Qdrant/`.amr` and the content from their Postgres; both on their
box.

## Cognition / dreaming / profiles
- Synthesis output is written via `ingestMemory` as a **cognitive-layer memory** — no separate tables.
  Profile = recall of cognitive memories about the user; dream = a cognitive memory. (We explicitly did
  NOT model these as relational sidecar tables.)
- Per-org entered at `cognition runOnce`, `dreamRetentionForOrg`, `dreamProfilesForOrg`.
- Relational bookkeeping (cluster dirty-flags, retrieval-tuning telemetry, advisory locks) lives in the
  SQL side (central PG, or the customer PG for self-host) — not forced into `.amr`.

## Security in the pipeline (maintained, all modes)
- **PQC** — `security/pqc-signer.js` `signMemory` runs in the engine before storage; signed memory is
  stored wherever the row lands. Key stays central.
- **Tenant-isolation middleware** — installed on **every** Prisma client (central and per-org customer
  client) → org-scoping enforced even on the customer PG.
- Content redaction, error sanitisation, rate limits, CSP — all engine-level, unchanged.

## The single seam (the whole point)
```
Everything above is identical for managed / self-host / .amr.
The ONLY per-org decision: getPrismaClient() (split client) + qbase() + amrRecall/amrWrite,
resolved inside runWithOrg(orgId, …). Change the org's registry entry → its data plane moves.
No feature code branches on the backend.
```

## Coverage status (honest)
Wrapped in `runWithOrg`: ingest, recall (both fns), profile-dream, cognition runOnce + retention.
**To wrap for 100% data-locality:** KB-ingest entry + a few connector write paths. Functionally features
work today; the sweep ensures *every* DB touch for a self-host org hits the customer PG.
