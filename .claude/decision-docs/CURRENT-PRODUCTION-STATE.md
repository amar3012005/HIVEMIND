# Current Production State

Observed: 2026-08-04 (runtime docs refresh from compose check).
This file is deliberately dated and drift-prone. Re-run the commands in
`OPERATIONS-AND-RELEASE.md` before relying on it for a release or pre-deploy
decision.

## Live Containers Observed

| Service | Image | Observed state |
| --- | --- | --- |
| `hm-core` | `hivemind/core-api:sha-9ad977571` | running |
| `hm-control` | `hivemind/control-plane:sha-701318ef2` | running |
| `hm-employees` | `hivemind/employees:prod-20260804-runtime-campaign-86f70547` | running |
| `hm-playwright` | `hivemind/hm-playwright:prod-20260728-seo-renderer-6dea0af63` | running |
| `hm-postgres` | `hivemind/postgres-age:15-age-custom` | running |
| `hm-qdrant` | `qdrant/qdrant:v1.12.4` | running |
| `hm-redis` | `redis:7-alpine` | running |
| `hm-tara-deepgram` | `hivemind/tara-deepgram:sha-bf7af3ca` | running |
| `tara-grok` | `hivemind/tara-grok:sha-951d64b4` | running |

The live image tags changed during concurrent work on August 2. Treat the container
inspection above as the authority for what was running when this document was
written, not older chat summaries.

## Source State Warning

At observation time `/root/hivemind-main` had active uncommitted changes and
parallel session deltas. The live images must not be assumed reproducible from a
single SHA without a reconciled commit/release artifact trail.

Do not merge, reset, copy, or clean broadly. Establish ownership per changed file,
integrate both sessions' work, commit a reproducible release, then rebuild.

## Runtime Features Present In Source

- Durable HQ Runtime state, instructions, queue, events, schedules, capability
  requests, playbook-linked workflows, and restart epochs.
- Versioned Runtime playbook registry with generic predicates, PostgreSQL
  checkpoints, snapshots, authority, Room dispatch, and provider adapters.
- GreenLeaf Bakery generality fixture.
- Outreach playbooks through v10, direct messaging, Gmail reply monitoring, and
  TARA call playbooks (`outreach-voice-call-to-outcome.v2`,
  `outreach-voice-cohort-to-outcomes.v1`).
- Campaign-awareness playbooks through v2 and Campaign Runtime adapter.
- `operations-admin-call-to-decision.v1` for internal HQ admin check-in calls.
- First-life policy and activation-start API controls with explicit start gating.
- Runtime-linked `HyperTurn` records for a continuous Room lifecycle.
- Runtime console with queue, authority/capability surfaces, instructions,
  checkpoints, restart, SSE hydration, and token counters.

Presence in source is not proof that every path is active in the current live
images. Confirm registration, database definitions, and a signed-in canary.

## Last Known Behavioral Verification

Recent canary-level observations indicate:

- Growth diagnostics were persisted before external execution when `first_life` was
  `awaiting_start`.
- Proposals can remain `PROPOSED` without dispatch until explicit `start`
  intent is recorded.
- Reach and authority gates were tracked by persisted events and not by implicit UI
  narration.

These results were observed before the latest live image replacement shown above.
They are historical evidence, not a substitute for re-running the canary.

## Recent Operational Incident

The frontend previously added `Cache-Control`/`Pragma` request headers while polling
`/v1/hq/work`. The API's CORS preflight did not allow `cache-control`, so the browser
blocked the request. The durable fix is query-string cache busting without those
custom request headers, or an intentional audited server CORS policy.

The host also reached full disk during concurrent image work. Builder and dangling
image cleanup restored free space, after which Redis persistence and new login
session writes recovered. Check disk and Redis persistence before diagnosing future
login/runtime failures as application bugs.

## Immediate Release Hygiene

1. Freeze Compose mutation to one release owner.
2. Reconcile parallel changes in `/root/hivemind-main` without overwriting either
   session.
3. Commit the exact Runtime/Campaign/Frontend source that should ship.
4. Build immutable images from that commit.
5. Keep one stable rollback and one current version for each affected service.
6. Deploy named services with `--no-deps`.
7. Run a fresh signed-in Playwright Runtime canary and update this file.
