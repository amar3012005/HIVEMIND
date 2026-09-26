export const COMPOSIO_CONNECTED_SKILL = `---
name: composio-connected
description: Load for connected-app work needing tool discovery, schema selection, execution, or connection recovery. Simple reads can use native tools directly.
---

Native hivemind_connected_task is registered separately from this skill. It calls governed Composio routes. Credentials stay on server. Runtime binds user and organization.

- search: pass toolkit and complete useCase. Include concrete user-supplied filters in knownFields before first search. Returns selected tool slugs, schemas, effects, and short-lived grants.
- schemas: pass grantId and exact toolSlug from search before execution when arguments are unclear.
- execute: read-only tool with grantId, exact toolSlug, and schema-valid arguments.
- execute_write: write tool with same selected grant and arguments; Think pauses for operator approval before execution.
- connection_status: inspect authenticated toolkit connection. manage_connection starts connection flow after approval. wait_connection checks whether connection became active.

Do not invent slugs or reuse expired grants. Treat tool receipts as evidence; report failure without claiming mutation succeeded.
`;
