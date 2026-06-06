# STATE — finish-backlog

> The cron reads this FIRST every run. Keep it accurate or work repeats.

status: IN_PROGRESS
current_phase: 1        # P1 = reconcile graph-action-executor.js
total_phases: 14
branch: reconcile/merge # reconcile phases commit here (1/11 qdrant-client already done)
last_verdict: GREEN     # prod cold-tests GREEN as of 18:39Z; reconcile/merge has qdrant+eval+deploy fixes
last_run: 2026-06-06T18:52Z (manual PLAN)

## Next concrete action
P1: 3-way reconcile core/src/resident/graph-action-executor.js into reconcile/merge.
  base=`git show 39224d7:<f>`, ours=main, theirs=`git show reconcile/prod-snapshot-39224d7:<f>`.
  Preserve both main-only and prod-only logic (union of intent). node --check. Commit to
  reconcile/merge. Reconcile = NO prod deploy (prod already runs its version).

## Phase checklist
- [ ] P1  reconcile graph-action-executor.js
- [ ] P2  reconcile faraday.js
- [ ] P3  reconcile result-reranker.js
- [ ] P4  reconcile recall-router.js
- [ ] P5  reconcile scheduler.js
- [ ] P6  reconcile run-manager.js
- [ ] P7  reconcile cluster-index.js (careful)
- [ ] P8  reconcile cognition-loop.js (CORE)
- [ ] P9  reconcile persisted-retrieval.js (CORE)
- [ ] P10 ff reconcile/merge → main; confirm main==prod, cold-GREEN
- [ ] P11 audit MeetingNotes.jsx (gap list, no code)
- [ ] P12 implement Meeting Notes redesign + deploy Vercel
- [ ] P13 finish bge-m3 dark wiring + design sandbox rehearsal
- [ ] P14 run bge-m3 sandbox rehearsal (NO live flip)

## Already done (do not redo)
- reconcile 1/11 qdrant-client.js (on reconcile/merge)
- eval probe-pool fix (recall 40%→93%), deploy-verified.sh scp-mode, T1 poll-fix — on reconcile/merge

## Blockers / open questions
- bge-m3 live flip (post-P14) requires explicit human go — do NOT auto-flip.
