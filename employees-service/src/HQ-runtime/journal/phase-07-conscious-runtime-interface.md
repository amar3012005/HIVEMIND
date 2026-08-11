# Phase 07 - Conscious Runtime Interface

## Outcome

Company HQ now renders as a continuous autonomous runtime transcript instead of
an operations dashboard. Human and specialist Rooms retain their existing
participant and discussion interfaces.

## Interface contract

- Durable HQ events stream into one chronological, bubbleless timeline.
- Wake and sleep boundaries are explicit: `[ Waking up ]` and `[ Sleeping ]`.
- Skill and tool references render as compact method/call chips with outcomes.
- Active work displays an animated `I` identity pulse and a short status only;
  private model chain-of-thought is never exposed.
- Decisions, observations, blockers, delegations, and checkpoints retain their
  persisted runtime titles, summaries, timestamps, and sequence.
- The HQ right rail contains runtime state, active work, and future checkpoints.
  It does not show the Room participant roster or agent hiring controls.

## Production evidence

- Frontend production build completed successfully.
- Current image: `hivemind/fe:prod-20260730-hq-runtime-stream-v2`.
- Rollback image: `hivemind/fe:prod-20260730-hq-runtime-v1`.
- Product route returned HTTP 200 and served `main.b28f7f2b.js`.
- Control Plane, Employees, Core, Deepgram, and Grok containers were not
  recreated by this frontend-only release.
