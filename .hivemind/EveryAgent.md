# EveryAgent

This directory is the repository's versioned ground truth for engineering work. It applies to every
agent and every worktree derived from this branch.

## Start

1. Read `CONTRACT.json`, `ROUTING.json`, and `BRANCH.json`.
2. Resolve the requested branch/ref; do not substitute `main` or a convenient checkout.
3. Work in a clean task worktree. Preserve unrelated changes.
4. Select exactly one platform skill using `ROUTING.json`. Load a second skill only when the task
   genuinely crosses its named boundary.
5. State the owned files, verification command(s), and rollback boundary before a material edit.

## Execution

- Prefer the smallest complete change that fixes the demonstrated boundary.
- Keep company memory in HIVE Core; use task-ledger infrastructure only when it is configured and
  relevant. A missing optional ledger is not a reason to stop ordinary implementation.
- Use the environment-specific release manifest for deployments. Never patch a running container
  or copy secrets from another environment.
- Use immutable artifacts, recreate only affected services, and verify the real route after release.
- Treat browser/UI proof, authorization, durable state, and provider receipts as distinct evidence.

## Model routing

- **Luna:** execute an already validated deterministic manifest.
- **Terra:** default for one bounded feature, bug, test, or frontend/backend repair.
- **Sol:** diagnose an unknown or cross-service contract problem and produce a bounded manifest.
- **Astra:** security/tenant boundaries, irreversible migrations, or final production review.

Escalation is a handoff note with the failing boundary and evidence, not a blanket stop condition.

## Finish

Record the source SHA, changed files, tests, artifact/deployment identity if any, and rollback target
in the task's PR, release record, or configured task ledger. Never store secrets, raw environment
values, credentials, private prompts, or provider payloads there.
