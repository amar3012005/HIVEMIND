# HIVEMIND Recall, Chat, and Ingestion — Current Production Handoff

Last updated: 2026-08-29

This directory is the canonical handoff for the current production behavior of the three coupled paths:

- [LATEST_RECALL_ARCHITECTURE.md](./LATEST_RECALL_ARCHITECTURE.md)
- [LATEST_CHAT_ARCHITECTURE.md](./LATEST_CHAT_ARCHITECTURE.md)
- [LATEST_INGEST_ARCHITECTURE.md](./LATEST_INGEST_ARCHITECTURE.md)

Read all three before changing recall, chat synthesis, canonical entity creation, graph relationships, or document ingestion. A change in ingestion can alter the metadata that recall filters require; a change in recall can make valid evidence invisible; a change in synthesis can discard correct recalled passages.

## Executive status

The latest canonical branch is `singulance-main` at `701a0504391764763cf479306db839b305c8320a` before this documentation merge.

Release chain:

| Commit | Change | Merged | Observed live |
| --- | --- | --- | --- |
| `5fa2150535e70b441b4c25d28a5c782f5332095f` | Entity projection parity across ingestion and recall, remote memory tag acknowledgement, query-aware deterministic synthesis, reconciliation tool | yes | yes, through the later `1e619ce7` image |
| `1e619ce72e5670069b7f5ba5e2c7a8b1c0a9ce7f` | Correct remote hydration driver import | yes | yes; Core, Control Plane, and Employees were healthy on this SHA |
| `701a0504391764763cf479306db839b305c8320a` | Reconciliation script selects current memories correctly | yes | not proven live during this handoff because another release owner held the canonical deployment claim |

Important: the production runtime fix is present in `1e619ce7`. The only difference in `701a0504` is the repair-script selector. Do not redeploy merely to claim parity; follow the release governor and verify the actual container/source tuple.

## What was repaired

For organization `0a1d5b33-a33c-49a6-8185-6d16370670a2`, document `a0e10107-3682-4219-bddb-0fef2d514363`, a dry-run and then a scoped no-reparse reconciliation were executed against the running Core container.

Observed repair result:

- 15 document memories matched.
- 3 source entities were resolved: `SINGULANCE`, `GLOBIA`, and `P&P`.
- 35 candidate entity links were applied.
- 35 links succeeded.
- 0 projection failures.
- 0 review items.
- No source bytes were reread or reparsed.

This repaired the entity projections that actually existed in the document output. It did not create `Paolo`, because `Paolo` was not among the entities extracted from those 15 promoted memories.

## What is still broken

The final production canary was not successful:

- `POST /api/recall` with query `Who is Paolo?`, `entities: ["Paolo"]`, quick mode, and limit 15 returned HTTP 200 with `0 memories` and `0 evidence`.
- `POST /api/chat` with `What should be our strategy with Paolo?` returned HTTP 200 with a grounded no-coverage response and zero sources.

Therefore:

- Chat did not hallucinate or dump unrelated passages. That guard is working.
- Final synthesis was not the primary failure in this canary; it received no usable rows.
- The unresolved defect is before synthesis: entity extraction/projection or filtered retrieval cannot connect `Paolo` to tenant-owned memory/evidence.
- Do not say recall/chat are “fully fixed” until the same authenticated canary returns relevant tenant-owned passages and a grounded answer.

## Most likely remaining root cause

Central canonical entity state contains a Paolo entity associated with older source metadata, but its linked central memory could not be hydrated from the tenant Memory Box. The newly uploaded document produced only SINGULANCE/GLOBIA/P&P entity projections. This creates a split state:

1. The planner correctly asks for entity `Paolo`.
2. The unified resolver can recognize the canonical entity.
3. The remote Memory Box has no `entity:paolo...` tag on the new document memories.
4. The evidence hard filter cannot retain a row unless its authorized metadata or content proves the entity.
5. Both lanes return zero, so synthesis correctly refuses to invent an answer.

The next session must prove whether the string `Paolo` exists anywhere in remote evidence before changing logic.

## Required next sequence

1. Inspect the target tenant’s remote evidence and document inventories for exact and normalized `Paolo` matches.
2. Inspect the central `CanonicalEntity` metadata for Paolo, including source document IDs and filenames.
3. Inspect the older linked Memory row centrally and determine whether it is recoverable, orphaned, or deliberately absent from the Memory Box.
4. If remote evidence contains Paolo, fix filtered evidence retrieval or its metadata projection and add a regression test.
5. If the uploaded source contains Paolo but promoted memories do not, fix canonical entity extraction at the ingestion intersection; do not add a Paolo-specific keyword patch.
6. If the only valid Paolo memory is central and the tenant is remote, perform an authorized, provenance-preserving migration into the tenant box and repair the orphaned link.
7. Re-run direct recall and chat canaries, inspect post-turn logs, then verify Documents/Evidence/Memories counts.

## Safety rules for the next session

- Work from a clean worktree based on current `origin/singulance-main`; the root checkout may contain unrelated user work.
- Production is `ssh singulance`.
- Never bypass the release-presence governor or another session’s release claim.
- Never widen a remote tenant failure into central cross-tenant recall.
- Never generate an entity, edge, or answer without source evidence.
- Do not reparse the document merely to repair projections when durable evidence already exists.
- A `202` upload acknowledgement is not success. Poll the job and verify durable vector coverage, projections, recall, and UI counts.
- Always delete temporary API keys and synthetic canary data.

## Definition of done

The work is complete only when all of these are true for an authenticated disposable or explicitly authorized tenant canary:

1. Evidence and memory lanes are searched in parallel.
2. Entity-filtered recall returns the correct passages when the entity exists.
3. Filename/source-filtered recall returns the correct document passages.
4. Temporal and memory-type filters preserve correct ordering and do not suppress valid evidence.
5. Chat synthesizes from all relevant returned rows, answers the user’s whole question, and cites the correct sources.
6. Zero coverage produces an honest bounded response, not unrelated evidence.
7. Ingestion cannot become `ready` with failed evidence embeddings.
8. Remote, managed, embedded, and hybrid storage obey the same recall contract.
9. Post-release logs contain no new recall, projection, transaction, shard, or proxy errors.

