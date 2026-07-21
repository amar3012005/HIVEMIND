# Phase 2 — One Composable Canonical Pipeline   🟡 PARTIAL

## Envisioned state
Explicit idempotent stages (authorize→normalize→persist source→segment→embed
evidence→mark ready→extract→curate→persist memories→resolve entities→validate
relationships→embed memories→verify coverage→complete), resumable from first
incomplete stage. Evidence recallable before async memory promotion. CanonicalIngestResult
{documentId, segmentIds, memoryIds, entityIds, relationshipIds, created, deduplicated,
coverage{candidates,promoted,merged,omitted,rejected,highValueCoverage}, timings}.

## Done (SHIPPED 5a8280e91 + ff2f78f3e, live)
2a: canonical_ingest_key + content_hash populated at KB ingest (doc identity live +
idempotent — same file twice = 1 doc row).
2b: claim_key populated at the UNIVERSAL createMemory chokepoint (prisma-graph-store)
→ every write path incl. bypasses gets claim identity, bypass-proof.

## Not done
Staged/checkpoint-resumable orchestrator; CanonicalIngestResult coverage{}+timings
return shape; verify-coverage stage; removal of ingestRoutedPayload fallback.

## Acceptance (met for identity)
Fresh atomic save → claim_key populated. Upload same file 2x → 1 doc.
