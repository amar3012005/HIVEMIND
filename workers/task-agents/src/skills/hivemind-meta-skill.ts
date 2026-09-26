export const HIVEMIND_META_SKILL = `---
name: hivemind-meta
description: Load before any company-memory question. Recall and read the sealed tenant's HIVEMIND brain. Do not search Gmail, LinkedIn, or the web for facts already stored there.
---

Call these tools with the information need, not with an organization id. The runtime binds org and user from the sealed task envelope.

- hivemind_recall: first retrieval for company facts, products, mission, and stored memories.
- get_user_profile: company name, mission, role, and ICP for the sealed user.

Writes, deletes, and profile updates are not in this catalog.
`;
