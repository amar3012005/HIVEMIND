# Phase 11 — Final Legacy Removal   🟡 PARTIAL
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
