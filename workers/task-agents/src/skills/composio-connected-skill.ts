export const COMPOSIO_CONNECTED_SKILL = `---
name: composio-connected
description: Load on each connected-app turn for fresh tool discovery, schema selection, execution, and connection recovery.
---

Native hivemind_connected_task is registered separately from this skill. It calls governed Composio routes. Credentials stay on server. Runtime binds user and organization. The backend owns the durable Composio session and tool cache; the model carries returned grants, not raw session IDs.

On every new connected-app task or turn, start discovery from the current request. If the user names an app, call search with its toolkit slug. If the app is unknown, call connection_status without a toolkit to list this user's connected apps, choose the matching toolkit, then call search. Search is scoped to one toolkit; it does not list every connected app. Do not call Composio for unrelated turns.

- search: pass toolkit and a complete, specific useCase naming the intended operation and outcome. Put concrete user-provided IDs, filters, time range, ordering, limit, and desired fields in knownFields when relevant; omit unknown fields rather than inventing provider syntax. For multiple apps or distinct operations, search each separately. The response supplies selected tool slugs, input schemas, read/write effects, connectionStatus, recommendedPlanSteps, and short-lived grants. Use plan steps as guidance, not executable tool names.
- Select a returned tool whose description and effect match the request. Read its inputSchema; call schemas with its grantId and exact toolSlug if arguments remain unclear. Supply required arguments from the user and preceding tool results. Do not guess slugs, field names, IDs, or missing required values.
- execute: use the selected read grant, exact toolSlug, and schema-valid arguments. Carry stable IDs from read results into later actions. Check successful, returned data, and receipt before reporting a result.
- execute_write: use the selected write grant, exact toolSlug, and schema-valid arguments. Think pauses for operator approval before execution. Report a change only after a successful receipt; distinguish partial results or provider failures.
- If connectionStatus shows the app disconnected, follow recommendedPlanSteps. Use the connectionGrantId from search with manage_connection only when connection setup is needed; this action requires approval. Then use wait_connection or connection_status to confirm the connection, and search again before executing.

Grants are scoped and short-lived. Start a new search for a new connected-app turn, changed intent, changed connection, or expired grant. Within a turn, reuse the selected grant for its matching tool instead of repeating identical searches. Never assume cached discovery proves a connection or action succeeded. Treat tool receipts as evidence; report failure without claiming mutation succeeded.
`;
