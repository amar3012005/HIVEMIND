# Phase 2 Journal: Runtime API And Stream

Date: 2026-07-30

## Implemented

- Tenant-scoped activation, pause, resume, wake, objective, state, event, work,
  and resource endpoints under `/v1/hq/*`.
- Activation is idempotent and schedules one immediate durable wake.
- Manual wake returns an existing queued/running cycle rather than duplicating it.
- Events use the runtime monotonic sequence and serialize bigint values safely.
- SSE replays persisted events, polls only while connected, emits heartbeats, and
  cleans up timers when the browser disconnects.
- Existing privileged-agent access remains the authorization boundary.

## Deliberately Not Yet Active

The route layer records requested wakes but does not run the HQ Director. Cycle
leasing and execution are Phase 3 backend work. No generic Room or legacy cycle
behavior has been changed.
