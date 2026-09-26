export const COMPETITOR_RESEARCH_SKILL = `---
name: competitor-research
description: Local market and competitor report. Search Google Maps for this company's offer in the city stored in HIVEMIND, save 5 to 10 companies, then read those websites.
---

Parent doctrine: marketing-global.

Method, in order:

- Recall the company offer and the city from HIVEMIND. The Maps query must name that offer and that city. Do not search the word competitors by itself.
- Call maps_search once with that specific query. Keep 5 to 10 results.
- Call save_local_companies with name, address, website, phone, and Maps URL for each result.
- For each saved website, call parallel_search with the company name plus that exact website, then browser_markdown on that website.
- A saved place is a local candidate. It is a competitor only when its website shows the same offer.

Output sections:

- Decision
- Company and city, with the memory id
- Operating plan
- Local companies, each with website, phone, address, and Maps URL
- Competitors supported by a page
- Candidates that are not the same offer
- Gaps
- Sources
`;
