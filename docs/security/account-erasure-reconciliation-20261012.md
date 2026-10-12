# Account source erasure reconciliation

Current source: origin/singulance-main 6e57877ee.

## Proven failure

`requireReconciledSourceErasure` counts all three source tables and rejects before account validation. No job is admitted, so "pending reconciliation" does not mean work is running. The guard also executes inside `performAccountDeletion`. Keep it until all required receipts exist.

## Reusable capabilities and verified gap

- Existing account deletion purges Qdrant user vectors, dependent SQL memories, graph relationships, and identity, but only after the guard.
- Knowledge ingestion has persisted jobs and stage receipts; its progress update fences cancelled/terminal jobs. That does not fence ingestion's content writes already in progress.
- Cloudflare source object service supports DELETE and HEAD using protected transport. Existing `deleteObject` swallows all errors and cannot prove erasure. New `deleteObjectVerified` checks DELETE status and HEAD absence, with authorization/retry classification.
- `kb/...`, `enterprise/...`, and connector source locations are computed locators; the document ingestion source explicitly documents that raw file bytes were not written at those paths. Never blindly unlink them. Payload text lives in SQL; remote/self-hosted sources need a real owner adapter/receipt.
- Cloudflare keys are org/checksum scoped, not user scoped. Another user's job/document may reference the same object: userId alone is insufficient permission to delete it.

## Required implementation sequence

1. Durable account-erasure request table keyed by user plus stable request ID; persist authenticated confirmation, immutable organization ownership snapshot, state, lease, retry deadline, last failure, and per-store coordinate receipts. No identity/cookie changes on admission.
2. Enforce erasure fence in upload admission, all existing ingest workers before every content write/promotion, and connector ingestion. Claim operation lease and wait for in-flight stages to settle; cancellation alone does not stop an executing parser.
3. Classify personal records vs retained shared-company records from scope tags and ownership. Reassign retained company records under a legitimate remaining owner before final identity deletion. A sole-owned organization deletion must be in authenticated deletion scope. Foreign references prevent physical object removal and retain a documented shared-object receipt.
4. For exclusively owned Cloudflare objects, invoke verified DELETE/HEAD. Persist receipt before deleting coordinates. Repeated DELETE with HEAD404 is successful; unauthorized/unconfigured store is a blocker, not success. Remote storage requires its authenticated tenant/agent erasure adapter; absent adapter blocks that scope.
5. Remove personal SQL source segments/documents/artifacts only after physical erasure/retention receipts. Persist vector/graph cleanup receipts using existing purge functions, then independently recount source inventory under the request's immutable scope.
6. Only completed reconciliation may call existing final account deletion; make finalization idempotent across restart. Preserve the current source guard as a final independent assertion. Run bounded batches and a lease/retry worker; do not make a browser request own irreversible progress.

## Acceptance checks

Disposable fixtures must cover personal-only, mixed/shared company, foreign org, shared checksum object, active ingest race, 403 authorization, transient 503 retry, crash after DELETE before receipt, restart after receipt before SQL cleanup, and duplicate confirmation. Verify no identity deletion before all required receipts; shared bytes and foreign rows unchanged. Never use real account deletion for verification.

This change provides the independently testable verified-object prerequisite. It does not yet wire or claim complete account erasure.
