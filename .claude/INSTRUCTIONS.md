# Claude Working Instructions - HIVEMIND

These rules apply to every Claude session in this repository. If a lower-level
skill, journal, archived plan, or old memory conflicts with them, these rules
and the linked authority documents win.

## Start Every Task

1. Read `.claude/README.md`, `docs/BRANCH_PROTOCOL.md`, the latest entries in
   `docs/ENGINEERING_JOURNAL.md`, and the task-specific decision document.
2. Inspect branch, status, parent SHA, frontend gitlink, and active ownership.
3. Use code-review-graph first, but verify a stale graph against source.
4. Work in an isolated branch/worktree based on `origin/singulance-main`.
5. Add a `Started` journal entry before editing.

## Engineering Rules

- Investigate the current implementation before proposing or editing.
- Extend canonical paths; do not create parallel ingestion, recall, chat,
  connector, billing, or deployment implementations.
- Preserve tenant, project, membership, role, plan, and storage boundaries.
- PostgreSQL is canonical for managed memory data; Qdrant generates candidates.
  Personal `.amr` and enterprise BYOD must satisfy the same public behavior.
- Public endpoint compatibility matters. Shared consumers must continue using
  canonical `/api/chat`, `/api/recall`, ingestion, connector, and graph paths.
- Never hide failures behind broad catches, fabricated fallbacks, or claims not
  supported by tests or production evidence.
- Preserve unrelated changes. Stage explicit files only.
- Do not commit secrets, tenant keys, customer data, or production environment
  values.

## Product Boundaries

- HIVEMIND: source-grounded evidence, durable memory, entities, typed graph,
  recall/chat, projects, connectors, meetings, MCP, usage, and billing.
- HyperAgents: organization-scoped rooms and governed AI work. It consumes
  HIVEMIND and connector capabilities; it does not own memory truth.
- TARA: `services/tara-deepgram` voice runtime. Voice uses the same identity,
  entitlement, memory, connector, approval, and audit controls. `tara-aaas` is
  legacy and must not be revived.

## Verification

- Run focused syntax, unit, integration, and contract checks for changed code.
- Test affected user-facing consumers, not only the implementation module.
- Security-sensitive changes require tenant-isolation, authorization, input,
  audit, and failure-path checks.
- A push is not a release; health is not feature acceptance.
- Record only pushed commits as `Committed`. Record production only after the
  release protocol's acceptance gates pass.

## Production

- Production is only `ssh singulance`. Never use `myserver` for central
  SINGULANCE services.
- Before any build, migration, restart, cleanup, or deploy, follow
  `docs/PRODUCTION_RELEASE_PROTOCOL.md`. It is the release authority.
- Build from clean pushed commits, preserve rollback, apply additive migrations
  before incompatible code, and verify the real tenant-scoped feature.
- Do not use `docker cp`, ad-hoc container edits, blind pulls/resets, mutable
  tags as deployment inputs, or destructive cleanup.

## Historical Material

`.claude/MEMORY.md`, `.claude/governance/`, archived loop goals, and old plans
are evidence of prior work, not current operational instructions. Re-verify
their claims before use.
