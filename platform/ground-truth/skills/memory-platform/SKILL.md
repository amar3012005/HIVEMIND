---
name: memory-platform
description: Safely build HIVE-MIND memory ingestion, evidence, recall, entity, scope, and hosted MCP capabilities.
---

# Memory platform workflow

Read `../../platform.yaml` and `../../capability-contracts.md` first.

1. Locate the durable Core owner and existing typed API/MCP contract.
2. Define the authorization subject and memory visibility set before query logic.
3. Preserve evidence provenance and lifecycle; do not claim ingestion completed
   until its terminal processing receipt exists.
4. For entities, return canonical names/aliases from the tenant-authorized
   inventory, then apply the selected entity filter to recall.
5. For a save, require one concrete write destination. Omit relationship fields
   unless an exact recalled record ID authorizes the relationship.
6. Add focused contract tests: authorization denial, scoped read, scoped write,
   persistence, and replay/temporal behavior when relevant.
7. Release Core alone through the migration-aware contract and run an
   authenticated canary.

Never use browser scope labels, a model-supplied tenant, direct database insertion,
or unbounded raw provider evidence as authority.
