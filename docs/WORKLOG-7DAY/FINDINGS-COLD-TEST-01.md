# Cold-Test Findings #01 — 2026-06-06 (first live run)

First real cold-test run against **live prod** (`hm-core`, canonical test org). NOT
hypothetical — real `/api/memories`, `/api/recall`, `/api/security/*`, real Prisma
assertions. Recorded honestly, with sparse-corpus nuance accounted for.

## CRITICAL infra fact
**Prod `/opt/HIVEMIND` is NOT running `git main`.** Server HEAD = `39224d7` (Jun 3)
with heavy uncommitted working-tree drift (modified server.js, control-plane,
cognition-loop, etc.). A `git pull` would clobber prod drift and risk an outage.
→ **Deploy mechanism here is scp-of-files + `docker restart`, not `git pull`.**
Any autonomous deploy MUST respect this. Reconciling drift→main is a supervised task.

## GREEN (verified working in prod)
| Layer | Evidence |
|-------|----------|
| **Recall (closed-loop)** | Ingest fact → recall retrieves it, p95 776ms. ✅ |
| **PQC integrity** | pubkeys loaded; audit-verify: checked=5 signature_valid=5 chain_intact=5 payload_bound=5 **tamper_evident=true** + checkpoint. ✅ |
| **Graph health** | latest=4, superseded=0 — no is_latest cascade explosion. ✅ |
| **Enrichment** | gpt-oss-20b extracts `canonical_entities` (org/person), facts, dates, summary; `enrichment_status: done`. ✅ |

## RED / SUSPECT (the hardening targets)
1. **Entity materialization gap (canonical pipeline).** Enrichment extracts entities
   into `source_metadata.metadata.enrichment.canonical_entities`, but they are **NOT
   promoted to `entity:*` tags** on the memory, and **no `ts:*` stamp tag** is added
   for the standalone `/api/memories` (`ingest_bucket: standalone`) path. The apex
   playbook says graph-engine stamps `ts:*` and `_attachEntityCoMentionEdges` writes
   `entity:<Name>` tags — absent here. → Entities computed but not graph-materialized
   for this path. **Highest-value fix target.**
2. **Async-write reliability.** Two near-simultaneous POSTs: factB persisted, factA
   not found at +40s. Queue may drop/delay concurrent standalone ingests. Needs a
   repro + root-cause (queue.js / pipeline-orchestrator).
3. **content_hash absent** from `source_metadata.metadata` for this path (dedup
   contract per apex doc) — confirm whether dedup uses a different mechanism now.

## Harness corrections made (legitimate test-correctness, not patchwork)
- `Relationship` model uses **`fromId`/`toId`**, not `fromMemoryId` (v1 edge count was invalid).
- `/api/memories` is **async** → returns `202 {job_id}`; tests poll by content.
- Recall smoke is now **closed-loop** (ingest-then-recall) to avoid sparse-corpus false negatives.
- T1 is a **2-fact shared-entity** test so edge=0 is a *real* failure, not a sparse artifact.

## Caveat honored
0 co-mention edges on a 1-memory org is EXPECTED (nothing to link to) — that's why
T1 now ingests two entity-sharing facts. We do not cry wolf on sparse corpora.

## Next (for the autonomous hardening loop)
- T1: harden factA persistence (retry/serialize concurrent writes) then re-confirm.
- Investigate finding #1 (entity tag + ts stamp materialization on standalone path)
  → this is the canonical-ingestion gap behind "I think relations are created."
- Once #1 is fixed on a branch + cold-tests green → user deploys via `deploy-verified.sh`.
