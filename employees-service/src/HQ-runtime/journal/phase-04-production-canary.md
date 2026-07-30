# Phase 4 - Production canary

Date: 2026-07-30

## Deployment

- Control Plane image: `hivemind/control-plane:prod-20260730-hq-runtime-v1`
- Product frontend image: `hivemind/fe:prod-20260730-hq-runtime-v1`
- Control Plane was recreated as one named Compose service with `--no-deps`.
- The product frontend was replaced independently. HyperAgents, Core, Deepgram, and Grok were not recreated.

## Route evidence

The public HQ endpoints return `401` without a session. This proves the deployed routes exist and remain tenant-authenticated:

- `GET /v1/hq/runtime`
- `GET /v1/hq/events`
- `GET /v1/hq/work`
- `GET /v1/hq/resources`

## Tenant canary

The native engine ran against organization `1380251c-f707-4aee-98a4-dd93b63b4a00` using its persisted company state. It completed one cycle with this durable event sequence:

1. `wake` - HQ woke
2. `context_loaded` - Current company state loaded
3. `decision` - Next operating action: monitor
4. `schedule_created` - Next checkpoint scheduled
5. `sleep` - HQ is waiting

The cycle completed with transition `WAIT`, no blocker, and a persisted next wake at `2026-08-06T10:09:08.832Z`. No continuously running model process remains between wake events.

## Remaining production boundary

HQ-created specialist Work Orders are durable and tenant-scoped. The existing specialist execution engine still consumes Work Orders inside Room turns. A dedicated dispatcher and compact Work Result return path remain the next phase before autonomous specialist delegation is considered end-to-end complete.
