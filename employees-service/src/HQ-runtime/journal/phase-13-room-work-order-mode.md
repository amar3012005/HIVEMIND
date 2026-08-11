# Phase 13 - Native Room work-order mode

Date: 2026-07-31

HQ Runtime work orders now execute inside the selected specialist HyperAgents Room instead of the legacy single-agent specialist endpoint.

## Runtime path

1. HQ semantically selects one available Company Room from the bounded work kind, objective, selected skill, and tenant Room catalog.
2. Core creates a durable Room turn and sends the private `hq-work-order.v1` envelope.
3. The Room Director clamps the turn to machine work-order mode, loads selected domain skills, and decomposes at most three sequential subtasks.
4. Each subtask plans and invokes real read/prepare tools through `Director._exec`; later subtasks can consume earlier outputs.
5. Engine-owned checks record tool calls, records created, evidence, and acceptance outcomes.
6. The Room returns `work-order-result.v1`. HQ accepts completion only when every subtask has a passing non-judgment check, every acceptance criterion is met, and no gap remains.

Human Room turns remain on their existing discussion, synthesis, production, and goalkeeper path. Work-order mode is selected only by the private envelope.

## Production evidence

- Control image: `hivemind/control-plane:prod-20260731-hq-work-order-v4`
- Employees image: `hivemind/employees:prod-20260731-hq-work-order-v8`
- Rollback images: `stable-before-hq-work-order-mode-20260731`
- Production canary Room turn: `fef2c2f6-d64c-49c9-98b2-4a7af4595f91`
- Canary result: `work-order-result.v1`, status `completed`, one real location-grounded Google Places call, 20 structured prospect records, one bounded subtask, deterministic acceptance passed, zero gaps, and no debate or full-report retry loop.
- The canary exposed model drift in a prose table. Structured tool rows are now the authoritative deliverable; the model cannot recreate, omit, or invent record rows.
- Focused tests: 13 Core tests and 29 employee Room/contract tests passed.
- Playwright desktop/mobile Runtime canary passed with no horizontal overflow.

## Safety boundary

The Room tool planner sees only the Director's registered read/prepare tools. External sends and publishing remain outside this execution mode and retain their existing approval/runtime governance.
