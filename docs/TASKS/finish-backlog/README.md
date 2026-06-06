# TASK: Finish HIVEMIND remaining backlog

**Slug:** finish-backlog
**Created:** 2026-06-06
**Owner cron:** (registered — see STATE)
**Status:** IN_PROGRESS
**Scope:** reconcile prod→main, AI Meeting Notes redesign, bge-m3 cutover rehearsal.
**Explicitly EXCLUDED:** HyperAgents, Cognitive layer (evolution loop) — do NOT touch.

## Vision
Finish the foundation: make main an accurate superset of live prod, then finish the
two half-built features (AI Meeting Notes UI, bge-m3 1024 vectors) — completing existing
work, never rebuilding, leaving no dead/duplicate code.

## Acceptance criteria
- [ ] main == prod functional superset (all 11 drifted files reconciled, ff'd to main, cold-tests GREEN)
- [ ] AI Meeting Notes page improved (existing MeetingNotes.jsx finished, not rebuilt) + deployed (Vercel) + visually confirmed
- [ ] bge-m3 1024 wiring finished + rehearsed on a SANDBOX collection (no live flip without explicit human go)
- [ ] zero dead/duplicate code introduced; cold-tests GREEN after every deployable phase

## Recon findings (RULE 0 — finish-first)
- **UNFINISHED to FINISH (do NOT restart):**
  - Reconcile: prod runs 11 hand-edited files never committed (prod AHEAD). Branch
    `reconcile/merge` already holds 1/11 (qdrant-client) + eval/deploy/harness fixes →
    CONTINUE from it. Prod snapshot = `reconcile/prod-snapshot-39224d7`.
  - AI Meeting Notes: `frontend/Da-vinci/src/components/hivemind/app/pages/MeetingNotes.jsx`
    EXISTS (control-deck redesign commits). FINISH/improve it, do not rebuild.
  - bge-m3: wiring EXISTS + dark across core/src/embeddings/factory.js, mistral.js,
    ingestion/indexer.js, vector/qdrant-client.js, container-router.js (flags
    EMBEDDING_FALLBACK_PROVIDER, QDRANT_PER_TENANT). FINISH = staged enable, not rebuild.
- **Dead/duplicate to remove:** check during each reconcile merge (one behavior = one impl).
- **Verification:** `core/scripts/cold-tests/run-all.mjs` (in-container). **Deploy:**
  `core/scripts/cold-tests/deploy-verified.sh` (FILES="..." scp-mode + backup + rollback).
- **CONSTRAINT:** prod runs DRIFT — NEVER git-pull. Edit prod's actual file version
  (snapshots in /tmp/proddrift or `git show reconcile/prod-snapshot-39224d7:<file>`).
  3-way merge: base=`39224d7`, ours=main, theirs=prod-snapshot. Preserve BOTH sides.

## Phased plan (one phase per cron run; reconcile = no prod deploy, prod already runs it)
Reconcile (each → 3-way merge into `reconcile/merge`, node --check, cold-test):
- [ ] P1  reconcile graph-action-executor.js
- [ ] P2  reconcile faraday.js
- [ ] P3  reconcile result-reranker.js
- [ ] P4  reconcile recall-router.js
- [ ] P5  reconcile scheduler.js
- [ ] P6  reconcile run-manager.js
- [ ] P7  reconcile cluster-index.js (52 sig main-only lines — careful)
- [ ] P8  reconcile cognition-loop.js (CORE, 264 diff — extra care, full 3-way read)
- [ ] P9  reconcile persisted-retrieval.js (CORE, 304 diff — extra care)
- [ ] P10 verify reconcile/merge cold-GREEN → fast-forward → main; confirm main==prod
AI Meeting Notes (deploy = Vercel via Da-vinci submodule push):
- [ ] P11 audit MeetingNotes.jsx — list concrete gaps vs desired (past meetings, recording
        animation, insights, dial hover, dates/days). Write gap list. No code yet.
- [ ] P12 implement the redesign FINISHING the existing component (frontend-design skill);
        push Da-vinci; bump submodule; flag for human visual review.
bge-m3 (HIGH risk — rehearsal only):
- [ ] P13 finish + document the dark wiring; design sandbox rehearsal (org_<sandbox>
        collection, 1024-dim) — no live flip.
- [ ] P14 run sandbox rehearsal: ingest+recall on sandbox collection, prove 1024 path works.
        STOP before any live EMBEDDING_DIMENSION flip — needs explicit human go.

## Safety notes
- Reconcile phases change main only (prod already runs the code) → no user impact.
- AI Meeting Notes is frontend-isolated; can't break backend; Vercel auto-builds.
- bge-m3 live flip is FORBIDDEN without human go (recall-blackout risk). Sandbox only.
- HyperAgents + Cognitive/evolution layer: OUT OF SCOPE — never edit.

## Rollback
- Reconcile: branch-only; nothing deployed. Discard branch if wrong.
- Meeting Notes: revert Da-vinci commit + submodule bump.
- bge-m3: sandbox collection is disposable; no prod env changed.
