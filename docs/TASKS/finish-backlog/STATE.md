# STATE — finish-backlog

> The cron reads this FIRST every run. Keep it accurate or work repeats.

status: IN_PROGRESS
current_phase: 13       # reconcile done(in-scope); P11 audit done; P12 dial preview-deployed (awaiting visual review); P13-14 bge-m3 next
total_phases: 14
branch: preview/meeting-notes-dial (P12) / reconcile/merge (reconcile)
last_verdict: GREEN (P12 JSX parse + preview pushed)
last_run: 2026-06-06 continuous

## Next concrete action
P13: finish/document bge-m3 dark wiring + design SANDBOX rehearsal (org_<sandbox>
  collection, 1024-dim). HIGH RISK — sandbox only. Live EMBEDDING_DIMENSION flip is
  FORBIDDEN without explicit human go. Best done as a dedicated focused run.
AWAITING: P12 visual review of Vercel preview (preview/meeting-notes-dial) before merge to main.

## Phase checklist
- [x] P1  reconcile graph-action-executor.js  (adopt prod, dark-safe)
- [x] P2  reconcile faraday.js                 (adopt prod, dark-safe)
- [x] P3  reconcile result-reranker.js         (adopt prod, dark-safe)
- [x] P4  reconcile recall-router.js           (prod ⊇ main)
- [x] P7  reconcile cluster-index.js           (adopt prod)
- [x] P9  reconcile persisted-retrieval.js     (adopt prod live recall, drops stale main funcs)
- [~] P5  scheduler.js      — SKIPPED: cognitive layer + diverged-both (out of scope)
- [~] P6  run-manager.js    — SKIPPED: cognitive layer + diverged-both (out of scope)
- [~] P8  cognition-loop.js — SKIPPED: cognitive layer (out of scope)
- [ ] P10 ff reconcile/merge → main — DEFERRED (supervised branch merge; main+reconcile diverged)
- [x] P11 audit MeetingNotes.jsx (gap list → meeting-notes-gaps.md)
- [x] P12 record dial added (hover + pulse rings, logic preserved) → preview/meeting-notes-dial (Vercel preview). AWAITING visual review before merge to main.
- [ ] P13 finish bge-m3 dark wiring + design sandbox rehearsal  ← NEXT (dedicated run; high risk)
- [ ] P14 run bge-m3 sandbox rehearsal (NO live flip — needs human go)

## Already done (do not redo)
- reconcile/merge holds prod versions of: qdrant-client, graph-action-executor, faraday,
  result-reranker, recall-router, persisted-retrieval, cluster-index, memory-eval + the
  eval probe-pool fix (recall 40%→93%), deploy-verified.sh scp-mode, T1 poll-fix.

## Blockers / open questions
- Cognitive-layer reconcile (scheduler/run-manager/cognition-loop): diverged-both (main has
  evolution+signal-gate; prod has budget-pool). Needs supervised merge. OUT OF SCOPE now.
- ff reconcile/merge→main: main & reconcile/merge diverged → real merge, do supervised.
- bge-m3 live flip (post-P14): requires explicit human go — do NOT auto-flip.
