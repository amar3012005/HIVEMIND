# STATE — finish-backlog

> The cron reads this FIRST every run. Keep it accurate or work repeats.

status: IN_PROGRESS
current_phase: 11       # reconcile of in-scope recall/memory files DONE; cognitive trio SKIPPED; now AI Meeting Notes
total_phases: 14
branch: reconcile/merge
last_verdict: GREEN
last_run: 2026-06-06 continuous

## Next concrete action
P11: audit frontend/Da-vinci/src/components/hivemind/app/pages/MeetingNotes.jsx —
  write concrete gap list vs desired (past meetings, recording animation, insights,
  dial hover, dates/days). No code yet. Then P12 = finish/redesign the existing component.

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
- [ ] P11 audit MeetingNotes.jsx (gap list, no code)  ← CURRENT
- [ ] P12 implement Meeting Notes redesign + deploy Vercel
- [ ] P13 finish bge-m3 dark wiring + design sandbox rehearsal
- [ ] P14 run bge-m3 sandbox rehearsal (NO live flip)

## Already done (do not redo)
- reconcile/merge holds prod versions of: qdrant-client, graph-action-executor, faraday,
  result-reranker, recall-router, persisted-retrieval, cluster-index, memory-eval + the
  eval probe-pool fix (recall 40%→93%), deploy-verified.sh scp-mode, T1 poll-fix.

## Blockers / open questions
- Cognitive-layer reconcile (scheduler/run-manager/cognition-loop): diverged-both (main has
  evolution+signal-gate; prod has budget-pool). Needs supervised merge. OUT OF SCOPE now.
- ff reconcile/merge→main: main & reconcile/merge diverged → real merge, do supervised.
- bge-m3 live flip (post-P14): requires explicit human go — do NOT auto-flip.
