export const PARALLEL_SEARCH_SKILL = `---
name: parallel-search
description: Load before external web research. Run governed Parallel search and keep only URL-backed citations.
---

- parallel_search: pass a query of at least three characters. The runtime calls Parallel directly through Cloudflare AI Gateway and returns URL-backed results or an explicit error.

Use the returned URLs and snippets as evidence refs. Do not treat an unsupported model summary as a source. Find-all, task, and enrichment runs are not granted here.
`;
