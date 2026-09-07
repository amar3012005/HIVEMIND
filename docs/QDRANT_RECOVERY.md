# Qdrant recovery

PostgreSQL is the canonical store for Documents, Evidence and Memories. Qdrant
is a rebuildable search projection. A Qdrant outage must reduce semantic recall,
not make canonical data unavailable or turn a retrieval error into a false
empty result.

## Recall behavior during an outage

- Memory recall continues through the tenant-scoped PostgreSQL lexical lane.
- Evidence recall continues through tenant- and document-scoped PostgreSQL
  phrase/token queries.
- Entity and temporal inventory lanes remain available when PostgreSQL is
  healthy.
- Semantic similarity is unavailable until Qdrant recovers. Callers with
  reliability tracing enabled receive failed vector-lane state and a degraded
  overall status.
- If PostgreSQL retrieval also fails, the API returns an unavailable error; it
  must not claim that no memories or evidence exist.

## Rebuild from PostgreSQL

Run inside the `hm-core` container. Start with the read-only inventory:

```bash
npm run qdrant:rebuild -- --dry-run
```

Rebuild every current Memory and every Evidence segment:

```bash
npm run qdrant:rebuild -- --commit
```

Restrict recovery to one organization when isolating a tenant incident:

```bash
ORG_ID=<organization-uuid> npm run qdrant:rebuild -- --commit
```

The operation is idempotent: Qdrant point IDs are the canonical PostgreSQL
Memory or KnowledgeSegment UUIDs, so retries overwrite the same projections
instead of creating duplicates. Each destination collection is ensured before
evidence upsert. Evidence rows receive `vectorStored=true` only after their
Qdrant batch succeeds. Either memory or evidence failures make the command exit
non-zero.

After rebuilding, run the coverage audit and an authenticated tenant recall
canary before declaring recovery:

```bash
node /app/scripts/recall-coverage-audit.mjs
```

The canary must prove both a semantic hit after Qdrant recovery and a lexical
hit with Qdrant deliberately unavailable. Container health alone is not a
recovery receipt.
