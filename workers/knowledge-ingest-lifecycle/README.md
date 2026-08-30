# Knowledge Ingest Lifecycle (local only)

This package owns orchestration only. PostgreSQL remains authoritative for jobs,
leases, checkpoints and settlement; the core API remains authoritative for
documents, evidence, memories, entities, relationships and citations. Queue and
Workflow payloads contain identifiers and counters, never document bytes.

All configured Cloudflare resource names end in `-local`. There is no production
environment in this package.

## Required gates

An upload selects this lifecycle only when all three gates are positive:

1. `HIVEMIND_LOCAL_MODE=true`
2. `KNOWLEDGE_INGEST_WORKFLOW_ENABLED=true`
3. Flagship `knowledge_ingest_workflow_v1` evaluates true for the organization

Missing configuration, an unreachable flag service, or a false decision fails
closed to the existing BullMQ lifecycle. The selected orchestrator is stored on
the job and cannot change during that processing version.

Use one generated local secret in both the core API environment and Wrangler:

```powershell
$env:KNOWLEDGE_INGEST_WORKFLOW_SECRET = '<local-only-random-secret>'
$env:KNOWLEDGE_INGEST_WORKFLOW_ENABLED = 'true'
docker compose -f docker-compose.local-stack.yml -f docker-compose.local-services.yml up -d --build
.\scripts\start-knowledge-ingest-workflow-local.ps1
```

The script rejects any Miniflare state path outside `P:`. Docker reaches the
host Worker at `http://host.docker.internal:8788`; local Wrangler reaches Core
at `http://127.0.0.1:3000`.

The hosted Cloudflare `local` environment uses
`https://preview-api.singulancelabs.com`. That control plane exposes only the
path-bounded `/internal/knowledge-ingest/v1/jobs/*` bridge when both local gates
are enabled and the dedicated Workflow secret matches. Never point this hosted
environment at a production API hostname.

## Verification

```powershell
npm test
npm run check
npm run dry-run
```

Use `wrangler dev --env local` for deterministic termination/restart tests. A
replayed Workflow stage returns its existing PostgreSQL receipt. A processing
checkpoint can be reclaimed only after its lease expires; lease-token fencing
prevents a late worker from settling the reclaimed receipt. Source objects are
deleted only after reconciliation and terminal settlement succeed.

For Cloudflare-hosted local validation, create/deploy only the names in
`wrangler.jsonc`, set the same local secret with `wrangler secret put`, and keep
the Flagship rollout limited to the designated test organization. Never rename
these resources to their production counterparts.

Accepted hosted deployment (2026-08-30): Worker version
`ad64498c-2489-459c-a664-7de235a7bd38`. Deterministic Paolo replay
`kb-cca99f31-fcfd-4707-b0ba-2d84de3f9d9c-v1` completed after two duplicate
starts with stable persisted counts.
