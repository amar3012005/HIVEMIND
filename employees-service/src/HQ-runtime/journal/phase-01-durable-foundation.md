# Phase 1 Journal: Durable Foundation

Date: 2026-07-30

## Completed

- Added tenant-scoped runtime, cycle, append-only event, and schedule models.
- Extended Work Orders for HQ cycles without requiring a Room turn at creation.
- Added idempotent manual SQL with lease, due-work, event, and ownership indexes.
- Added explicit runtime states, allowed transitions, authority normalization, and
  compact specialist result-packet validation.
- Added transaction-safe event sequencing and idempotent cycle/schedule creation.
- Added HQ-only director instructions and descriptor-first skill registry.

## Compatibility

No API route, scheduler, Room dispatch, campaign adapter, connector, frontend, or
voice behavior changed. Existing HyperAgents Work Orders with a `turnId` retain
their original uniqueness contract.

## Evidence Required Before Phase 2

- Prisma 5.22 schema validation passed in the pinned production Core image.
- Three focused Node contract tests passed in the pinned production Core image.
- Both HQ runtime modules passed `node --check`.
- The complete migration executed successfully inside `BEGIN` / `ROLLBACK`
  against production PostgreSQL; no schema changes were retained.
- Existing Work Order producers were inspected and continue supplying `turnId`.

Phase 1 status: complete in source, validated, not deployed.
