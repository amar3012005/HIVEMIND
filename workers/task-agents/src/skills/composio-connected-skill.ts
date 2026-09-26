export const COMPOSIO_CONNECTED_SKILL = `---
name: composio-connected
description: Load for connected-app workflows needing discovery, schema selection, or several read steps. Simple reads can use the native tools directly.
---

These are native Worker tools registered separately from this skill. The runtime calls governed Composio routes. Credentials stay on the server. This Worker currently exposes reads only; production DeepSeek Harness has a broader connected-task tool.

- composio_discover_reads: pass toolkit and useCase. Returns public tool schemas and a short-lived grantId for each read tool. It does not execute anything.
- composio_read: pass grantId, toolSlug, and arguments from that discovery response. A missing or expired grant is denied.

Do not invent slugs. Do not send email or mutate a connected app from this catalog.
`;
