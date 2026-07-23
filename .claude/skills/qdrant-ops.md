# Qdrant Operations

Qdrant is tenant-scoped candidate retrieval, not canonical memory truth.

Before changes, resolve the tenant storage backend and collection through the
current storage driver. Never assume a shared collection name. Audit:

- PostgreSQL canonical-memory to Qdrant point coverage;
- payload indexes for tenant/project/source/latest/time filters;
- vector dimensions/model compatibility;
- orphan and stale-version points;
- snapshot freshness and restore procedure.

Authorization is rechecked during canonical hydration. A vector hit never
grants access. Do not repair by deleting/recreating production collections
without a reviewed, resumable migration and rollback.
