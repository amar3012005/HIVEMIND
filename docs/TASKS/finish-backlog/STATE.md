# STATE — finish-backlog

> The cron reads this FIRST every run. Keep it accurate or work repeats.

status: NEARLY_COMPLETE  # all in-scope phases done; only human gates remain
current_phase: done-pending-review
total_phases: 14
branch: preview/meeting-notes-dial (P12) / reconcile/merge (reconcile)
last_verdict: GREEN
last_run: 2026-06-06 continuous

## Remaining (human gates only — not autonomous work)
1. P12: visual-review the Vercel preview of preview/meeting-notes-dial → merge to main if good.
2. Cognitive trio reconcile (scheduler/run-manager/cognition-loop): OUT OF SCOPE (you said skip) + diverged-both → supervised if ever wanted.
3. ff reconcile/merge→main: supervised branch merge when you choose.
bge-m3 (P13-14): CLOSED — already live in prod (1024 per-tenant), nothing to do.

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
- [x] P13 bge-m3 — ALREADY LIVE (not pending): verified on prod EMBEDDING_DIMENSION=1024, QDRANT_PER_TENANT=true, hm-qdrant, per-org org_<id> collections @ dim 1024 + HIVEMIND_PERSONAL (personal=filter). Every task uses this. No cutover/rehearsal needed.
- [x] P14 bge-m3 — n/a (cutover complete in prod; cold-test recall 93% already ran against per-tenant 1024).

## Already done (do not redo)
- reconcile/merge holds prod versions of: qdrant-client, graph-action-executor, faraday,
  result-reranker, recall-router, persisted-retrieval, cluster-index, memory-eval + the
  eval probe-pool fix (recall 40%→93%), deploy-verified.sh scp-mode, T1 poll-fix.

## Blockers / open questions
- Cognitive-layer reconcile (scheduler/run-manager/cognition-loop): diverged-both (main has
  evolution+signal-gate; prod has budget-pool). Needs supervised merge. OUT OF SCOPE now.
- ff reconcile/merge→main: main & reconcile/merge diverged → real merge, do supervised.
- bge-m3 live flip (post-P14): requires explicit human go — do NOT auto-flip.
