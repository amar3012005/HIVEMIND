# Prod ↔ Main Reconciliation Plan

## The situation (measured 2026-06-06)
Prod `/opt/HIVEMIND` HEAD = `39224d7` + **uncommitted hand-edits**. Main = `39224d7`
+ ~40 clean commits. They diverged. Classification of the 26 drifted tracked files:

| Class | Count | Files | Action |
|-------|-------|-------|--------|
| **CLEAN** (prod==main) | 15 | server.js, control-plane, tara/*, embeddings/*, container-router, schema, both .py, prisma-graph-store, document-first-ingestion, evidence-retrieval | none — already live & in git |
| **PROD-AHEAD-ish** | 4 | cluster-index, faraday, graph-action-executor, result-reranker | 3-way merge (mostly adopt prod) |
| **DIVERGED** (both changed) | 7 | qdrant-client(1), recall-router(10), memory-eval(10), run-manager(42), scheduler(39), **cognition-loop(264)**, **persisted-retrieval(304)** | careful 3-way merge |

Prod snapshot captured at branch `reconcile/prod-snapshot-39224d7` (RIGHT side of merge).

## Key facts driving the approach
- **Prod is LIVE and working.** Reconciliation goal = make MAIN an accurate functional
  superset of prod, so future upgrades don't regress prod. It does NOT require changing prod.
- **Not a clean superset.** persisted-retrieval has 77 significant main-only lines +
  203 prod-only; cognition-loop 27 main-only + 234 prod-only. A line-copy either
  direction LOSES work. → real semantic 3-way merge required (preserve both intents).
- **Reconciliation is low prod-risk** (main-only changes until verified). Deploy of the
  merged main happens ONLY after cold-tests green AND confirmed ≥ prod behavior.

## Per-file order (lowest risk first)
1. qdrant-client.js (1)  2. graph-action-executor.js (5)  3. faraday.js (14)
4. result-reranker.js (19)  5. memory-eval.mjs (10)  6. recall-router.js (10)
7. scheduler.js (39)  8. run-manager.js (42)  9. cluster-index.js (80)
10. cognition-loop.js (264) — core, extra care  11. persisted-retrieval.js (304) — core, LAST, supervised

## Per-file merge contract (no patchwork, no lost work)
For each file, using base=`39224d7`, ours=`main`, theirs=`reconcile/prod-snapshot`:
1. Read all three. Understand each main-only and prod-only hunk semantically.
2. Produce a merged file = union of intent: every prod-only behavior + every main-only
   behavior, no logic dropped. If two hunks conflict, the NEWER/working one (prod, since
   it's live) wins, but main's addition is preserved unless genuinely superseded — and
   any intentional omission is noted in the commit.
3. Syntax/lint check + run cold tests against prod test-account.
4. Commit merged file to `reconcile/merge`. Record in this doc's progress log.
5. Do NOT deploy mid-reconcile (prod already runs its side).

## After all 11 reconciled
- Fast-forward `reconcile/merge` → main. main is now the accurate source of truth.
- From here, real feature upgrades build on main and deploy via `deploy-verified.sh`
  (scp changed files + cold-test gate + auto-rollback). THIS is when users get upgrades.

## Progress log
- 2026-06-06: classified 26 files; prod snapshot branch created. Merge not started.
