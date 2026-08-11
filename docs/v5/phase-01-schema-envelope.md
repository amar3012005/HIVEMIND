# Phase 1 — Schema & Canonical Envelope   🟡 PARTIAL (schema ✅ / envelope-contract ⬜)

## Envisioned state
Canonical identity + claim metadata on the schema. One globally-unique
canonicalIngestKey (org, type, provider, externalId, version, contentHash).
Index (orgId, claimKey, isLatest, deletedAt); claimKey NOT unique. canonical-ingest.js
exposes the final CanonicalSourceEnvelope contract + validation.

## Done (SHIPPED 9b9bc1b07, live)
KnowledgeDocument +canonical_ingest_key/source_external_id/source_version/
content_hash/processing_version (+partial UNIQUE (org_id,canonical_ingest_key)).
Memory +claim_key/claim_subject/claim_predicate/claim_qualifiers/extraction_confidence
(+index memories_org_claim_latest_idx). Additive idempotent DDL; backup taken; down.sql.

## Not done
Named CanonicalSourceEnvelope contract rewrite + canonical-ingest.test.js. (Envelope
already works as JSDoc IngestEnvelope + legacyPayloadToEnvelope; formalization deferred.)

## Acceptance (met for schema)
`/api/ingest/source` atomic twice → #1 updated, #2 skipped_redundant, 1 DB row.
