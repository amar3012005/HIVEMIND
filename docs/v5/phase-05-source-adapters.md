# Phase 5 — Source Adapter Replacement (5A-5E)   🟡 5B+5D ACCEPTED; 5A/5C/5E canonical (need fixtures)

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


## Acceptance results (real-cURL, real user)
- 5D KB: upload→re-upload = 1 doc (idempotent); recall returns uploaded content
  exactly ("10 gigabits per second"). ACCEPTED.
- 5B MCP/chat saves: /api/ingest/source type=mcp atomic → ok, source=mcp; recall
  returns it ("500 requests per minute"). Canonical front door handles mcp/chat/api
  uniformly. ACCEPTED.
- 5A images / 5C meetings / 5E connectors: route through the same ingestSource
  canonical front door per Phase-0 recon, but full acceptance needs fixtures
  (a real image + vision model, a transcript, OAuth'd Gmail/Slack) not available
  in this test env. Canonical routing confirmed by recon; end-to-end fixture
  acceptance pending.

## STATUS 2026-07-21
Recon confirmed KB/image/meeting/chat-session/connectors/MCP-primary already route through
ingestSource. Phase 2b made claim IDENTITY universal at the createMemory chokepoint
(incl. bypasses). RESIDUAL (risky, needs own cycle): route /api/memories POST +
/api/enterprise/upload + Tara store.createMemory through the envelope for provenance/
dedup consistency (identity already present). Deferred as risky hot-path (a rushed
corroboration change already caused a data-loss near-miss this session).

## SHIPPED 2026-07-21 — 5B + 5C bypasses CLOSED (real-cURL verified)
- 5B /api/memories (highest-traffic write): routed through ingestCanonicalPayload
  (envelope) via ingestRoutedPayloadCanonical — provenance tags + claim identity on
  rows VERIFIED, response shape byte-compatible, zero fallbacks. Trees keep engine path.
  Flag V5_MEMORIES_CANONICAL.
- 5C Tara voice: all 4 raw store.createMemory sites (transcript/call-log/outreach/
  session-summary) → canonical EVIDENCE mode (one row, no fact-splitting). saved.id
  shape preserved for PartOf edges. Loud fallback during migration.
- REMAINING: /api/enterprise/upload/ingest — swap blocked by a REAL hazard: the
  envelope atomic path does NOT forward skip_fact_extraction, so enveloping enterprise
  chunks would silently enable fact extraction (behavior+latency change). Needs an
  envelope contract extension + a real enterprise fixture test. Own cycle.
