# SINGULANCE engineering ground truth

This directory is the canonical operating contract for the SINGULANCE platform.
It is deliberately small: it defines ownership, boundaries, runtime modes, and
release verification. Everything else is implementation detail or historical
reference.

## Read in this order

1. [platform.yaml](platform.yaml) — product, service, runtime, and environment ownership.
2. [capability-contracts.md](capability-contracts.md) — which boundary owns each behavior.
3. [delivery-contract.md](delivery-contract.md) — deterministic delivery and rollback rules.
4. The one skill matching the requested work in [skills/](skills/).
5. For delegated or lower-tier execution, a validated task manifest in
   [workflows/](workflows/).
6. [EveryAgent.md](../../.agents/hivemind/EveryAgent.md) — shared operating
   behavior and capability discovery for every coding-agent host.

## Authority hierarchy

1. This directory and its versioned schemas.
2. The active repository's resolved runtime configuration and deployed artifact.
3. Typed service contracts and provider receipts.
4. Source code and focused tests.
5. Historical journals, README files, chat transcripts, and screenshots.

Historical documents are evidence only. They cannot override this contract or
authorize a release.

## Contract versioning

`platform.yaml` has the contract version. A repository consuming this contract
pins that version in `platform-contract.json`. A contract change is valid only
when the schema check passes and its consumer repositories have been assessed.

Run:

```bash
node platform/ground-truth/scripts/validate-platform-contract.mjs
```

Use the commands inside the selected skill verbatim. A model must not invent
deployment topology, credentials, provider arguments, or fallback routing.

For a release, a senior model creates a complete
[`release-manifest.json`](release-manifest.schema.json) and validates it. A
lower-capability model may then execute only its specified workflow:

```bash
node platform/ground-truth/scripts/validate-release-manifest.mjs release-manifest.json
```

## Deterministic task execution

A senior model turns a bounded request into one task manifest. The manifest
selects exactly one specialist skill, the permitted file surface, commands,
checks, risk tier, release target, and rollback when needed. Validate it before
any lower-tier execution:

```bash
node platform/ground-truth/scripts/validate-task-manifest.mjs task.json
```

`luna` executes only mechanical, non-release work. `terra` executes a bounded,
approved task. `sol-astra` owns critical architecture, security decisions, and
production release manifests.

## Repository cleanup

Inventory before cleanup; do not delete or move agent instructions, journals,
or documentation based on filename alone:

```bash
node platform/ground-truth/scripts/inventory-agent-surface.mjs . /tmp/agent-surface-inventory.json
```

The inventory is read-only. Archive actions require a separate approved task
manifest, an explicit source-to-archive mapping, and a post-move link/check
verification.

For local Git worktree hygiene, use the separate read-only inventory. It never
deletes a worktree or branch:

```bash
node platform/ground-truth/scripts/inventory-worktrees.mjs . /tmp/worktree-inventory.json
```
