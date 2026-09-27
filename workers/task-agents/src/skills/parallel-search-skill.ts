export const PARALLEL_SEARCH_SKILL = `---
name: parallel-search
description: Load before external web research. Run governed Parallel search and keep only URL-backed citations.
---

- For broad research, call parallel_search_batch once with four or five distinct, complementary queries (for example: market demand, direct competitors, buyer accounts, regulation, counterevidence). Queries run concurrently; results retain each query and its own error. Inspect all batches before deciding what to verify next. Do not send near-duplicates merely to fill slots.
- For one narrow fact, call parallel_search with one query. Do not force a batch when one source is enough.

Use returned URLs and snippets as discovery evidence; open primary pages for material claims. A query or model summary is not a source. Partial batch failure does not erase successful results; name material gaps. Find-all, task, and enrichment runs are not granted here.
`;
