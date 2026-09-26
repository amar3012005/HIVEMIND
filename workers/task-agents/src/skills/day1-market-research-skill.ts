export const DAY1_MARKET_RESEARCH_SKILL = `---
name: day1-market-research
description: Local Day 1 playbook for a source-backed competitor and market brief anchored to the company website and operating location.
---

Required output sections, in this order:

- Company: name, website, and operating location from the packet or HIVEMIND memory.
- Direct competitors: companies a buyer could hire instead, each with a URL.
- Adjacent alternatives: nearby options that are not the same offer, each with a URL.
- Buyers: who the evidence says the offer is for.
- Positioning: how this company describes itself versus how competitors describe themselves.
- Local demand: signals tied to the named market, each with a source.
- Assumptions: claims that are useful but not yet sourced.
- Gaps: facts the task still needs.
- Sources: the URL or memory id for every factual sentence above.

Method:

- Start at the company website with browser_markdown.
- Recall company mission, offer, and location with hivemind_recall.
- Search for competitors in that market. Keep the geographic anchor.
- Do not invent a market size. If no source gives one, put that in Gaps.
`;
