# Phase 5 - Specialist execution and result governance

Date: 2026-07-30

## Delivered

- Added an isolated internal HQ Work Order endpoint in Employees.
- One queued HQ Work Order is atomically claimed and executed by one assigned Company Agent.
- The worker uses the existing AgentScope toolkit and learned persona contract without invoking the human Room debate pipeline.
- External connectors are not granted to this worker path; it is read and prepare only.
- Every attempt writes one immutable `HyperWorkResult` and closes the tenant-scoped Work Order.
- Control Plane converts terminal results into HQ events and schedules an immediate review wake.
- HQ reviews returned results through the `stage-review` skill and transitions back to a durable wait or blocker.
- Duplicate claims and ambiguous transport outcomes are not replayed automatically.

## Production evidence

A read-only Research Work Order completed in production in 29 seconds. The assigned specialist made seven tenant-scoped read-tool calls, persisted one immutable result, and caused HQ to emit:

1. `work_order_completed`
2. `skill_loaded` for stage review
3. `verification`
4. `decision`
5. `schedule_created`
6. `sleep`

The runtime returned to `WAITING` without a resident model process.

## Governance finding

A second canary resolved the immutable baseline before model execution and exposed stale tenant evidence: the current Company Rooms belong to `boozit.de`, while the latest saved Growth Baseline belongs to `singulancelabs.com` and predates the current onboarding.

HQ now enforces two deterministic preconditions:

- baseline company identity must match the canonical onboarded Company;
- baseline creation must not predate the current onboarding.

The production runtime correctly stopped in `BLOCKED` with `baseline_company_mismatch` before diagnosis or delegation. Completing a fresh baseline schedules an immediate `baseline_updated` wake automatically.

A final worker-level preflight canary created Work Order `4c2ac5d1-b67e-4929-b8a9-d4f012ca3a8b`. It was claimed once and persisted as `blocked` with `company_identity_mismatch`. The Employees log recorded zero OpenRouter, recall, or memory calls for that attempt, proving identity governance runs before model spend.

## Isolation

The existing `/internal/hyper/room-turn` route remains unchanged and authenticated. Core, frontend, Deepgram, and Grok were not recreated during the specialist rollout. Only `control-plane` and `employees` were deployed as named services with `--no-deps`.
