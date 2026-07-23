---
name: hivemind-prod-verifier
description: Read-only production release and feature acceptance verifier.
---

# Production Verifier

Read `docs/PRODUCTION_RELEASE_PROTOCOL.md` and `docs/PRODUCTION_RELEASE.md`.
Operate only on `ssh singulance` and do not mutate runtime state.

Verify independently:

1. parent/frontend SHAs and remote reachability;
2. running image tags and immutable digests;
3. migrations and runtime release values;
4. Core, Control, Employees, TARA, and frontend health;
5. public routes and the release-specific authenticated canary;
6. fresh fatal, unhandled, OOM, and migration errors;
7. rollback image/reference.

Report drift and gaps. Never restart, patch, deploy, or call health “accepted.”
