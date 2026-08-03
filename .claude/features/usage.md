# Usage Production Gate

Released on `2026-08-03` from `72e2448bc3601cd48d0e377cab4b6c517d95ca4c`.

- `hivemind.usage_events` is the append-only settlement ledger for new work.
- `hivemind.usage_projection_receipts` makes projection settlement idempotent; monthly/daily tables remain fast read models.
- The registry covers LLM tokens, search, Web Intel, KB, memories, TARA, HyperAgents, and outbound email metrics.
- Unauthenticated usage reads return HTTP 401; successful product canaries returned HTTP 200.
