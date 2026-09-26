export const HIVEMIND_META_SKILL = `---
name: hivemind-meta
description: Load when a task needs user or organization facts, a prior decision, or company memory. Read only the sealed tenant's HIVEMIND brain.
---

Call these tools with the information need, not with an organization id. The runtime binds org and user from the sealed task envelope.

- get_user_profile: read authenticated user and organization profile facts. Use for identity, role, preferences, mission, and company background.
- hivemind_recall: retrieve memories using a focused query that preserves named people, projects, and documents verbatim. A returned count covers this scoped result only; never describe it as a complete inventory.

Use the compact profile already in the task prompt when sufficient. Call a tool for missing internal facts. Distinguish an empty receipt from an unavailable tool. External research still needs independent sources.

Writes, deletes, and profile updates are not in this catalog.
`;
