# Work Room Boundary Handoff

## Completed

### Phase 2: Adaptive, Dependency-Aware Work Plans

Commits: `260d894 hyper: add dependency-aware work room turn plans`,
`dd64c10 hyper: persist blocked work room plan steps`

- Human Work Room Directors may return a bounded `turn_plan` of stable step IDs and dependencies.
- Independent steps run concurrently; a dependent step receives completed prerequisite notes.
- Each step persists its `plan_step_id` and `depends_on` metadata in `hyper_work_orders`.
- Dependency failures create a durable blocked order and visible `needs_attention` projection instead
  of disappearing as an in-memory deadlock.
- Runtime work-order execution remains on its existing single-envelope path.

### Phase 3: Continuous Work Timeline

Commits: `787109a hyper: project durable work room plans`,
`7ddc29b hyper: wire work plan projection into room timeline`,
`500c88b hyper: keep work room timeline live`

- `GET /v1/hyper-rooms/:roomId/work-plan` is a tenant-scoped projection over
  persisted work orders and results. It maps durable blocked orders to the user-facing
  `needs_attention` state and includes prerequisites, owner, summary, blocker, and timestamps.
- The Room UI renders one compact Work Plan above its turn transcript and refreshes it once for
  each unseen persisted `work_order` event. It has no second polling or lifecycle authority.
- Frontend submodule revision: `211e9ef hyper: refresh work plan from live room events`.

### Phase 0: Explicit Room Boundary

Commit: `0eb280b hyper: separate human work rooms from runtime rooms`

- Added durable `HyperRoom.roomMode` (`work` or `runtime`) and additive manual SQL migration:
  `core/prisma/migrations/20260808110000_hyper_room_mode/migration.sql`.
- Company task clicks now create or reuse only `work` rooms, retain stale specialist-room links as
  `legacy_room_id`, and dispatch `room_mode: work`, `task_tag: WORK`.
- Follow-up, approval, and flyby dispatches derive the persisted room mode rather than recreating
  a specialist tag from task content.
- Domain homes, HQ-created kind rooms, and the legacy autonomous cycle are explicitly `runtime`.

### Phase 1: Human Work Room Behavior

- Work Rooms resolve to neutral `general`; Runtime rooms preserve their playbook/tag-selected kind.
- Work Room Directors receive a shallow catalog of all available methods and load selected bodies
  progressively. They are instructed to choose direct answer, evidence, debate, artifact, or a
  Runtime proposal based on the active request rather than the legacy task label.
- Direct answers no longer claim a polished report is expected merely because their output kind is
  `answer`.

## Verification Evidence

Command:

```bash
python3 -m py_compile employees-service/src/hivemind_employees/api_hyper_rooms.py \
  employees-service/src/hivemind_employees/hyper/engine.py \
  employees-service/src/hivemind_employees/hyper/skills/__init__.py
```

Output: success.

Command:

```bash
docker run --rm --entrypoint python -v /root/builds/codex-work-room-boundary:/workspace:ro \
  -w /workspace -e PYTHONPATH=/workspace/employees-service/src \
  hivemind/employees:prod-20260807-fae8cee5ce75 -c '<loads and invokes test_domain_rooms>'
```

Output: `12 domain-room checks passed`.

Command:

```bash
docker run --rm --entrypoint node -v /root/builds/codex-work-room-boundary:/workspace:ro \
  -w /workspace/core hivemind/core-api:prod-20260808-366af2c1c1f2 --check src/control-plane-server.js
docker run --rm --entrypoint node -v /root/builds/codex-work-room-boundary:/workspace:ro \
  -w /workspace/core hivemind/core-api:prod-20260808-366af2c1c1f2 --test \
  tests/unit/domain-rooms.test.js tests/unit/work-room-boundary.test.js
```

Output: 6/6 passing Core checks; no syntax errors.

## Current State

- Worktree: `/root/builds/codex-work-room-boundary`
- Branch: `codex/work-room-boundary`
- Base at start and before commit: `origin/singulance-main` `366af2c`.
- No deployment, migration application, or shared-tree edits were performed.
- Current worktree should be clean except this handoff file before committing it.

## Remaining Phases

1. Add generic per-step states and exact waits (`active`, `waiting_for_input`,
   `waiting_for_approval`, `waiting_for_capability`, `completed`, `needs_attention`) backed by
   durable records. A Work Room may propose a Runtime lifecycle but cannot advance a Runtime
   playbook.
2. Add frontend grouping so all work under one human task reads as one continuous Work Room
   timeline; direct answers stay compact; real debate/tool work is visibly attributable.
3. Add integration coverage for a human task click, a direct answer, an evidence/debate request,
   and a proposed Runtime handoff. Then rebase this branch on current `origin/singulance-main`,
   push, merge via PR, apply the manual SQL migration, and release only named services from the
   canonical merge SHA under the release lock.

## Decisions

- `roomMode` defaults to `work` for new arbitrary rooms. Permanent Company Rooms and all
  Runtime-created rooms are explicitly `runtime`; the migration backfills current non-general
  and domain-home rooms as `runtime`.
- The pre-existing HQ keyword dispatcher is not redesigned in this commit. It is a Runtime/HQ
  path, not the user task-click path. Its semantic playbook replacement belongs to the later
  routing phase, not this boundary repair.
- No full skill bodies are injected into Work Room prompts. The catalog is shallow so the
  Director still decides methods semantically and token use stays controlled.

## Exact Next Action

Rebase the isolated branch on the current canonical SHA, run the manual additive SQL migrations,
then deploy the merged canonical Core, Employees, Control Plane, and frontend images under the release lock.
