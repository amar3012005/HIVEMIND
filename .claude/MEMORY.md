# Claude Durable Context

This file contains only low-drift orientation. Git, source, tests, the
engineering journal, and the production release ledger are authoritative.

## Platform

SINGULANCE is an AI company operating system with three connected products:

- HIVEMIND: source-grounded organizational memory and context.
- HyperAgents: governed organization-scoped AI work and outcomes.
- TARA: real-time voice interaction through `services/tara-deepgram`.

All products share server-derived identity, organization/project authorization,
plans, usage, connectors, audit, and canonical memory contracts.

## Architecture

- Frontend: `frontend/Da-vinci` Git submodule.
- Control plane: `core/src/control-plane-server.js`.
- Core engine: `core/src/server.js` plus focused route/service modules.
- HyperAgents: `employees-service/` plus Core room/event routes.
- TARA: `services/tara-deepgram/` plus `core/src/tara/`.
- Managed memory: PostgreSQL canonical and Qdrant candidate retrieval.
- Personal memory: per-tenant `.amr` slots.
- Enterprise BYOD: customer-owned Box storage behind the same API behavior.

## Standing Decisions

- One canonical ingestion path for every source adapter.
- Metadata and authorization constrain recall eligibility before ranking.
- `/api/chat` orchestrates shared recall/write/connector tools; it does not own
  a separate data plane.
- Entity and graph truth must be typed, provenance-backed, and tenant-scoped.
- Backend ground truth owns user type, role, hosting mode, plan, usage, and
  feature gates.
- External actions require approval, audit, and idempotency.
- `singulance-main` is integration/release truth; tasks use isolated branches.
- Production is `ssh singulance` and follows the mandatory release protocol.

## Start Here

Read `.claude/README.md`, `.claude/INSTRUCTIONS.md`,
`docs/ENGINEERING_JOURNAL.md`, and the relevant `.claude/decision_docs` file.
For prior detail, use Git history rather than restoring old commands here.
