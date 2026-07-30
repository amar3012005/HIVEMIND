# Phase 08 - Owned Bootstrap

## Outcome

HQ no longer blocks and asks the user to run a baseline it already owns. A
missing, stale, or cross-company baseline activates the HQ-only
`baseline-establishment` skill and calls `growth_baseline_collect` with a full
transfer. Once accepted, the same cycle loads the growth diagnosis skill and
calls `growth_plan_run`.

## Model and usage contract

- Baseline establishment is deterministic tool execution and records zero LLM
  input/output tokens.
- Growth diagnosis selects `gpt-oss-120b` from the skill model policy.
- The selected model is passed into the planner instead of being hidden as a
  planner constant.
- Provider-reported prompt and completion usage is retained on the plan/tool
  result and aggregated for the HQ input/output counters.
- A Growth Plan is current only when it references the latest baseline. A new
  company baseline therefore receives a new initial operating plan.

## Interface and reset

- Runtime events speak in a concise first-person operating voice.
- Tool and skill calls retain durable references and model metadata.
- The production organization's legacy HQ transcript, schedules, cycles, and
  unfinished Work Orders were cleared before the next SINGULANCE onboarding.
- Runtime state is `OBSERVING` with no active cycle, schedule, Work Order, or
  post-reset token usage.
- Company replacement now clears transient HQ execution state through the HQ
  repository boundary. Completed business artifacts retain their own governed
  history, while active Work Orders are cancelled and the runtime transcript,
  cycles, and schedules restart cleanly.
- Successful onboarding activates the organization's HQ with the new company
  objective and schedules one idempotent `onboarding_complete` wake. The first
  native cycle then owns baseline establishment and growth planning.

## Production images

- Control Plane: `hivemind/control-plane:prod-20260730-hq-conscious-v3-r3`
- Frontend: `hivemind/fe:prod-20260730-hq-conscious-v3`
- Rollback Control Plane: `hivemind/control-plane:prod-20260730-hq-conscious-v3-r2`
- Rollback Frontend: `hivemind/fe:prod-20260730-hq-runtime-stream-v2`
