# Phase 11 — Final Legacy Removal   🟡 dead-mirror removed; bypass sweep REMAINS
## Envisioned state
Zero: direct ingestMemory from source routes, direct Qdrant writes from adapters,
duplicate DocumentFirstIngestionService, source-specific entity/relationship
persistence, Smart-Ingest fallback, legacy recall fallback, memoryType=relationship.
Replaced code removed as each caller migrates. Only backward-compatible public
request parsing kept (converted immediately to canonical internally).
## Done
Deleted dead core/src/external/ingestion mirror (18 files, 0 refs) — SHIPPED bb5fb3762.
## Not done
The bypass sweep (depends on Phase 5/7/8 migrations completing first).
## Acceptance
Repo-wide checks show zero of the above; all source cURLs + graph + recall/chat +
delete + restart + latency + managed/.amr/BYOD parity green on one immutable release.

## STATUS 2026-07-21
Done: deleted dead external/ingestion mirror. REMAINS: the bypass sweep depends on Phase 5
caller migrations completing first (route /api/memories + enterprise + Tara through envelope),
then delete the legacy routed path. Risky hot-path — own cycle.

## SWEEP PROGRESS 2026-07-21
Deleted the provably-dead legacy KB ingest path (132 lines: chunker + direct
ingestMemory + direct qdrant storeMemory) from routes/knowledge.js — every branch
above it returns. KB upload + coverage verified green after removal. REMAINING in
sweep: legacy routed path (ingestRoutedPayload) stays as the TREE path + loud-logged
fallback until telemetry confirms zero fallback use over time; Tara raw-store
fallback likewise.
