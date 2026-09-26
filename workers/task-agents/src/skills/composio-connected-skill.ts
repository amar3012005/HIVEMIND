export const COMPOSIO_CONNECTED_SKILL = `---
name: composio-connected
description: Load before using an app the company has connected. Discover read-only Composio tools for one toolkit, then execute only a granted slug.
---

The runtime calls the existing governed Composio routes. Credentials stay on the server.

- composio_discover_reads: pass toolkit and use_case. Returns public tool schemas and a short-lived grant id. It does not execute anything.
- composio_read: pass grant_id, tool_slug, and arguments from that discovery response. A missing or expired grant is denied.

Do not invent slugs. Do not send email or mutate a connected app from this catalog.
`;
