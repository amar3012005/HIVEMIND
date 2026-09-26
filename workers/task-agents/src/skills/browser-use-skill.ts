export const BROWSER_USE_SKILL = `---
name: browser-use
description: Load before reading a live page. Use Cloudflare Browser Run quick actions, not a custom crawler.
---

Think exposes these tools when the Browser Run binding is present:

- browser_markdown: read a page or HTML as markdown.
- browser_extract: extract structured fields from a rendered page.
- browser_links: list links.
- browser_scrape: read elements by CSS selector.
- browser_execute: run CDP only when the quick actions cannot see the content.
- browser_capture: capture a public HTTPS page with native Browser Run and save its full-page PNG as an artifact in this turn. Call it directly for public-page screenshots; Composio search and connected-app grants are for account-specific apps, not public pages.

Pass the sealed task's evidence URL. Do not browse an unrelated site, and do not type credentials into a page.
`;
