# HyperAgents Handoff

**Date:** 2026-08-30  
**Parent branch:** `codex/hyperrooms-copy-profile-and-artifact-feedback-20260829`  
**Frontend submodule branch:** `codex/hyperrooms-artifact-feedback-ui-20260829`

## Current Step

Push the frontend submodule commit, then push the parent branch; after that, run a controlled canary with one text-copy Room turn and one explicitly visual Room turn.

## Completed And Verified

### 1. Isolated worktree

Work was performed in `/root/builds/hyperrooms-copy-profile-and-artifact-feedback-20260829`, created from `origin/singulance-main`. No files were changed in `/root/hivemind-main` or the active deployment worktree.

### 2. Copy-vs-visual routing repair

Parent commit: `3c89b978 fix(hyperrooms): keep copy turns out of visual rendering`

Changed:

- `employees-service/src/hivemind_employees/hyper/execution_profiles.py`
- `employees-service/src/hivemind_employees/hyper/engine.py`
- Focused tests under `employees-service/tests/`

Behavior:

- Added `marketing.copy.v1` for text-only positioning/tagline/messaging/copy work.
- Restricted `marketing.artifact.v1` to explicitly requested designed visual deliverables.
- Enforced `execution_profile.allowed_outputs`: text-only profiles discard planner `artifact_intent`.
- Added durable visual progress/rejection events and retained renderer error details.

### 3. Frontend event handling

Submodule commit: `6de2526 fix(hyperrooms): show visual artifact progress and rejection`

Changed:

- `frontend/Da-vinci/src/components/hivemind/app/pages/HyperAgents.jsx`
- `frontend/Da-vinci/src/components/hivemind/app/hyperagents/rooms/shared.jsx`

Behavior:

- Subscribes to `artifact_progress`, `artifact_candidate`, and `artifact_rejected`.
- Shows a compact live render state, a verified artifact card, or a concise rejection panel with the renderer errors.
- Uses `event_id` before legacy fields when deduplicating stream/poll events.

### 4. Checks actually run

```text
docker run --rm --entrypoint python ... hivemind/employees:sha-f88b3a2e
runtime contract checks passed
```

That runtime probe verified:

```text
text-only marketing.copy.v1 ignores a planner-provided presentation intent
two failed visual render receipts preserve the last renderer error
visual progress stages are emitted in the expected order
```

```text
python3 -m py_compile employees-service/src/hivemind_employees/hyper/execution_profiles.py employees-service/src/hivemind_employees/hyper/engine.py
exit 0
```

```text
CI=true npm run build
frontend build output verified
```

`git diff --check` and `git show --check` were clean.

## Not Verified / Do Not Overclaim

- Host `pytest` could not collect because the host Python environment lacks `httpx`; this was an environment issue, not a test assertion failure. Run the focused pytest command in CI or a dependency-complete Employees test image.
- No deployment was performed.
- No live Room canary has been run on these commits.
- The parent branch references a local frontend submodule commit until both branches are pushed.

## Remaining Acceptance Steps

1. `git -C frontend/Da-vinci push -u origin codex/hyperrooms-artifact-feedback-ui-20260829`
2. `git push -u origin codex/hyperrooms-copy-profile-and-artifact-feedback-20260829`
3. In CI/service image, run focused Employees tests:

```bash
cd employees-service
PYTHONPATH=src pytest -q tests/test_execution_profiles.py tests/test_adaptive_director.py tests/test_visual_artifact_path.py
```

4. Build the employees image and Cloudflare frontend from the exact pushed commits.
5. Canary test a text-only request, e.g. `Refine the positioning statement for Europe`:
   - persisted `execution_profile.profile_id = marketing.copy.v1`
   - `output_mode_selected.mode = text`
   - no `artifact_progress` or `artifact_candidate`
6. Canary test an explicit visual request, e.g. `Create a slide-by-slide investor deck`:
   - visual profile/output selected
   - frontend shows progress immediately
   - success yields `artifact_ready`, failure yields `artifact_rejected` with errors
7. Only then use the established named-service deployment procedure. Do not run bare Compose commands, `compose down`, or broad container recreation.

## Decisions

| Ambiguity | Options | Selected reversible decision |
|---|---|---|
| Plain copy routed to artifact-only profile | Disable all visuals; add a text profile; rely on planner prompt | Added `marketing.copy.v1` plus an engine output-contract gate. Explicit visual work remains enabled. |
| Visual failure visibility | Generic warning; expose raw candidate HTML; persist structured rejection | Persist structured rejection details and render a bounded FE panel. Invalid HTML remains hidden. |
| Parallel deployment | Deploy now; modify active checkout; isolate work | Used a new worktree and did not deploy. |
| Test dependencies missing on host | Install ad hoc packages; skip behavior test; use pinned runtime image | Used pinned Employees image for contract probes; leave full pytest to CI/service image. |

## Separate Work To Avoid Mixing In

`codex/hyperrooms-chat-tools-bridge-20260828` contains a connector-bridge experiment. It has unresolved provider inventory, replay/seal, side-effect recovery, and company-state concurrency audit findings. It is intentionally not included in this handoff branch.
