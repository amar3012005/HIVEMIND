export const COMPOSIO_CONNECTED_SKILL = `---
name: composio-connected
description: Load when work needs a connected app. Discover read-only Composio tools for one toolkit, then execute a granted slug.
---

The runtime calls the existing governed Composio routes. Credentials stay on the server.

- composio_discover_reads: pass toolkit and useCase. Returns public tool schemas and a short-lived grantId for each read tool. It does not execute anything.
- composio_read: pass grantId, toolSlug, and arguments from that discovery response. A missing or expired grant is denied.

Do not invent slugs. Do not send email or mutate a connected app from this catalog.
`;
