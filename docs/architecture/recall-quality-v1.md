# Recall quality v1

This is an additive candidate-generation experiment. PostgreSQL remains the authority for memory content, ownership, scopes, and final authorization. Qdrant is a replaceable search index; a vector hit never becomes user-visible until Core hydrates and checks the memory.

## Admission and rollback

The sole rollout control is the Cloudflare Flagship string flag `recall_quality_v1`, targeted by exact `org_id:user_id` and defaulting to `off`.

| Mode | Serving path | Background vector repair |
| --- | --- | --- |
| `off` | Existing recall only | None for this feature |
| `shadow` | Existing recall only; compute and count extra candidates | Targeted users only |
| `on` | Union extra authorized candidates before existing Core ranking and hydration | Targeted users only |

Invalid flag values, missing Worker credentials, network errors, and non-central memory backends fail closed to the existing recall path. Set the flag to `off` to stop using the additional search path immediately; no schema rollback or data deletion is needed. Existing vector payloads can retain the additive fields.

## Data and retrieval

New memory vectors carry `scope`, `project_id`, `project_ids`, and `team_id`. A background cursor walks all latest Postgres memories for targeted owners, repairs absent dense points, and backfills a named sparse vector plus scope payload. The cursor and sparse-sync ledger are durable in migration `20260924120000_recall_quality_reconciliation`. Replays upsert by memory UUID. Do not enable `shadow` before applying this migration.

The extra Qdrant filter always requires the tenant organization and permits only the caller's own points, organization points, or points from authorized project/team IDs. It excludes non-memory layers and promoted raw segments. Core rechecks authorization after hydration. A second candidate lane favors the currently selected project. Dense and sparse searches fuse with Qdrant RRF when the collection has been prepared; older/unprepared collections use the additive dense search. Qdrant v1.18 or later is required to add the named sparse vector to an existing collection; an older server does not block legacy recall.

The `on` variant retains the existing lexical lane, ranking, citations, and explicit result limits. Only unbounded explain/full requests receive the larger evidence window. It does not create per-department collections or ingestion-time relationship edges.

## Promotion proof

1. Apply the Core migration, then release Core and the canonical-projection Worker as separate immutable artifacts. Leave Flagship `off`.
2. Apply `20260924150000_indexed_entity_search` as well, then target one internal `org_id:user_id` at `shadow`; confirm the background cursor advances, sparse/BM25 sync is acknowledged, indexed entity candidates are logged, and ordinary recall output remains unchanged.
3. Capture authenticated baseline/candidate result pairs with expected evidence IDs, authorized IDs, and end-to-end latency. Run `node core/scripts/eval-recall-quality.mjs <results.jsonl>`. The gate requires zero unauthorized IDs, no Recall@5/10 loss, no material MRR loss, and at most 20% p95 latency increase.
4. Check exact-name/keyword, synonym, entity, project, team, temporal, deleted/superseded, BYOD, and cross-tenant fixtures. Only then promote the same target to `on`; repeat via the public API and chat.
5. Set `off` on any regression and confirm current recall output is restored without redeployment.

Do not treat unit tests, a successful Qdrant response, or candidate counts as production retrieval-quality proof.

## Indexed entity selection

The same flag controls entity candidate selection. `off` retains the bounded
inventory lookup, `shadow` compares it with the indexed candidate path without
changing results, and `on` uses the indexed path with automatic fallback.

Canonical names and aliases are projected into
`canonical_entity_search_aliases` by a database trigger. Selection order is
exact canonical name, exact alias, indexed prefix, then `pg_trgm` fuzzy match.
The selected canonical ID is authorized through `memory_entity_links` and the
existing memory scope rules before it is returned. Same-name candidates remain
separate rows; this layer never merges identities.

Qdrant native BM25 is a third, optional text-rich memory lane beside dense and
deterministic sparse retrieval. It is never the identity authority. Shared
collections use the organization filter as the Qdrant 1.19+ IDF corpus; if the
server cannot honor that contract, recall falls back to dense + deterministic
sparse rather than using cross-tenant IDF statistics.

Compare baseline and candidate deployments on labeled real queries with:

```bash
node core/scripts/eval-entity-search-quality.mjs \
  --fixture=entity-queries.jsonl \
  --baseline=https://baseline.example \
  --candidate=https://candidate.example \
  --token="$HIVEMIND_EVAL_TOKEN"
```

Each JSONL fixture contains `query`, `expected_entity_ids`,
`authorized_entity_ids`, and optional `ambiguous_entity_ids`, `entity_types`,
`scope`, and `project_id`. Promotion
requires non-regressing Recall@1/5 and MRR, preservation of every labeled
same-name candidate, zero unauthorized results, and an acceptable P95.
