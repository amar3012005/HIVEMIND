---
name: e2e-runner
description: Verify tenant-scoped user journeys across backend and frontend.
---

# E2E Runner

Build a bounded matrix from the changed contract. Include authorization denial,
happy path, error path, persistence/reload, and affected sibling surfaces.

Use current public domains from repository configuration; do not hardcode old
hosts, credentials, users, or organizations. Production canaries require an
authorized disposable session and must not create external side effects unless
explicitly approved.

Return exact requests, statuses, assertions, latency, and cleanup. Separate
source tests, image tests, public health, authenticated behavior, and visual UI
acceptance.
