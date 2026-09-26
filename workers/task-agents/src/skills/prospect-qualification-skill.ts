export const PROSPECT_QUALIFICATION_SKILL = `---
name: prospect-qualification
description: Load while qualifying sourced prospect accounts against the company's recalled ICP.
---

- Recall the company's offer and ICP before searching. Search for buyer accounts in the requested market, not only for the company's own name.
- For each candidate, inspect its own page or a search result that names it and supports its location and fit. Include the source URL beside the account.
- Reject an account when source does not support its location or ICP fit. Mark missing buyer details unknown; do not invent contacts, budgets, or interest.
- Give each accepted candidate a short fit reason tied to the recalled ICP. Keep unsupported leads out of the final list.
`;
