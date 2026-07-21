# Phase 5 — Source Adapter Replacement (5A-5E)   ⬜ NOT STARTED (identity already universal via 2b)

## Envisioned state
Only EXTRACTION differs per source; after normalization all sources use one
implementation. Source-specific code extracts/normalizes only — never persists
memories/entities/edges/vectors directly.
- 5A Images: one detailed visual-description memory; entities extracted downstream.
- 5B MCP/Chat saves: atomic canonical envelope only; update = successor + atomic
  predecessor demotion + preserved history; remove duplicate save impls + fallbacks.
- 5C Meetings: transcript = timestamped evidence segments; promote decisions/
  commitments/owners/deadlines/outcomes; delete bespoke meeting memory gen.
- 5D KB: keep /api/knowledge/upload contract; remove alternate upload trees.
- 5E Connectors: Gmail/Slack = documents w/ ordered message segments; CRM/calendar
  = connector_record; framework owns provider→envelope; remove per-connector persist.

## Current
Most sources ALREADY route through ingestSource (recon). Bypasses remain:
/api/memories POST, /api/enterprise/upload, store.createMemory class (Tara etc.).
2b made claim IDENTITY universal even on bypasses, so this is now envelope/
provenance/dedup consistency, not missing data.

## Acceptance (real cURL, per source)
Each source ingested twice → one canonical source object, stable provenance,
no dup, correct segments/provenance, source-specific recall works.
