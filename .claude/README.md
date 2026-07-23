# Claude Context Map

This directory is a thin execution layer. Product truth lives in code and the
canonical repository documents; `.claude` must not become a competing source
of architecture or deployment truth.

## Read Order

1. [`INSTRUCTIONS.md`](INSTRUCTIONS.md)
2. [`../docs/BRANCH_PROTOCOL.md`](../docs/BRANCH_PROTOCOL.md)
3. [`../docs/ENGINEERING_JOURNAL.md`](../docs/ENGINEERING_JOURNAL.md)
4. Task-specific records in [`decision_docs/`](decision_docs/README.md)
5. For production, [`../docs/PRODUCTION_RELEASE_PROTOCOL.md`](../docs/PRODUCTION_RELEASE_PROTOCOL.md)

## Directory Roles

- `decision_docs/`: current decisions and authority map.
- `hyperagents/`: current HyperAgents context plus append-only history.
- `agents/`, `skills/`, `workflows/`: reusable roles and procedures; they must
  defer to the authority documents above.
- `governance/`, `loop/`, `plans/`: historical or task-specific records. They
  are not production instructions unless an active decision document says so.
- `MEMORY.md`: historical session notes. Verify drift-prone claims in code,
  Git, and production before relying on them.

Never store secrets, customer credentials, production API keys, or raw customer
data in this directory.
