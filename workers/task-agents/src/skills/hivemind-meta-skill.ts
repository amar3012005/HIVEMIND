export const HIVEMIND_META_SKILL = `---
name: hivemind-meta
description: Load for focused company-memory retrieval, profile interpretation, or temporal recall. Simple lookups can call hivemind_meta directly.
---

The native hivemind_meta tool is registered separately from this skill. Call it with information need, never model-supplied tenant IDs. Runtime supplies org and user from task envelope.

- context: refresh compact authenticated profile context.
- profiles: inspect authenticated user and organization profile facts.
- entities: find canonical entities by exact named subject before resolving an ambiguous identity.
- recall: retrieve memories with a focused query. Preserve named people, projects, and documents verbatim; use scopeFilter, validAt, transactionAt, sourcePlatforms, or filename only when task calls for them. Count covers this scoped result only, never complete inventory.
- save: persist a confirmed stable preference, decision, correction, or completed outcome only after operator approval. Never save secrets or guesses.
- save_status: inspect a prior save by its receipt's idempotencyKey only when save returned pending. A completed save receipt already confirms persistence; do not poll or retry it.

Use the compact profile already in the task prompt when sufficient. Call a tool for missing internal facts. Distinguish an empty receipt from an unavailable tool. External research still needs independent sources.

Deletes and profile updates are unavailable.
`;
