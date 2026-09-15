# SINGULANCE platform contract

Read [platform/ground-truth/START_HERE.md](platform/ground-truth/START_HERE.md) before planning, editing, testing, or deploying.

This repository owns the canonical platform contract. Product repositories consume
the versioned contract; they do not copy or reinterpret it.

## Non-negotiable operating rules

- Work from a clean, bounded branch. Preserve unrelated work.
- Establish the real runtime, release target, and first failing boundary before
  changing source. A healthy container is not end-to-end proof.
- HIVE memory, account identity, and runner state are authoritative only in their
  owning services. Browser state, prompts, temporary files, and container mounts
  are never durable authority.
- Native Harness behavior is extended through resolved Cordis profiles, scoped
  plugins, typed tools, and typed session projections. Do not patch its agent
  loop or generated client output.
- Connected applications resolve provider/account/tool contracts from their
  authoritative session. Reads are bounded; writes require one editable approval
  and an idempotent provider receipt.
- The native Harness and LangGraph orchestrator are explicit feature-flag modes.
  `harness` selects native Harness; every other or unknown value selects legacy.
  Never use legacy as a hidden repair for a native implementation failure.
- Deployment is artifact-specific. Use the documented Worker, Core, or
  runner-only workflow; do not rebuild unrelated systems or mutate a live
  container.
- Production claims require: the exact source commit, immutable artifact identity,
  configuration revision, database migration state when relevant, and an
  authenticated browser canary.

## Model allocation

- **Luna:** deterministic, pre-validated commands and mechanical checks only.
- **Terra:** bounded implementation from an approved contract and test plan.
- **Sol/Astra:** architecture decisions, cross-boundary changes, security review,
  and exceptions. Their output must become a deterministic contract before a
  lower-capability model executes it.

## Required skill routing

- Memory ingestion, recall, evidence, entities, and MCP: `memory-platform`.
- Users, organizations, projects, authentication, usage, and billing:
  `identity-platform`.
- DeepSeek Harness/Cordis modes, native UI, connected apps, or durable agent
  state: `cordis-harness-platform`.
- Worker, backend, database, container, tunnel, or production delivery:
  `platform-release`.

The canonical documents, schemas, and verification commands are under
`platform/ground-truth/`.
