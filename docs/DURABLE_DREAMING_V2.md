# Durable Dreaming v2

Durable Dreaming v2 is additive and feature flagged. It preserves the public
cognition contract and runs only when both the backend gate and the Flagship
master flag are enabled.

## Ownership

- Cloudflare Cron discovers due tenants every 15 minutes; it never reads memory.
- Queue messages contain tenant and trigger identifiers only.
- Cloudflare Workflow executes and retries the twelve durable stage callbacks.
- PostgreSQL owns runs, checkpoints, candidates, derivation receipts, profiles,
  revisions, and publication state.
- The canonical cognition gateway owns generated memories. Existing production
  AI Gateway/model routes and Qdrant semantics remain unchanged.

## Lifecycle

`admit → select-subjects → walk-graph → generate-candidates → verify-candidates
→ persist-cognition → project-derivations → update-profiles → embed → reconcile
→ publish → finalize`

Each stage leases a unique `(run, version, stage, shard)` checkpoint and returns
the stored receipt on replay. Publication requires complete grounding, memory,
relationship, and vector reconciliation. The master flag is checked again at
the publication boundary.

## Local resources and gates

- Worker/workflow: `hivemind-dream-lifecycle-local` /
  `hivemind-dream-workflow-local`
- Queue/DLQ: `hivemind-dream-trigger-local` /
  `hivemind-dream-trigger-dlq-local`
- R2: `hivemind-dream-artifacts-local`
- Backend gate: `DREAM_WORKFLOW_V2_ENABLED=true`
- Worker URL: `HIVEMIND_DREAM_WORKER_URL`
- Rotated service secret: `HIVEMIND_DREAM_WORKFLOW_SECRET`
- Flagship: `dream_workflow_v2` and the seven operator flags in the Worker.

All flags default false and fail closed. Secrets belong in Wrangler secrets or
local secret files only. Local bindings must never reference production data or
resources.

## Recovery and release

Deterministic Workflow IDs and PostgreSQL trigger keys coalesce duplicates.
Retryable failures reach the environment DLQ after exhaustion. Completed
checkpoints are replay safe. Operators can cancel runs, review quarantined
candidates, and inspect profile history.

Legacy cadence remains active when v2 is false. When v2 is true, adaptive dirty
cluster ownership moves to the Worker; both implementations must never own one
organization concurrently.

Merge and runtime-test this feature in `singulance-local`. Production resources
must be created disabled and promoted separately through the governed
`singulance-main` rollout. This document does not authorize production.
