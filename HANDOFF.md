# Web Intel Production Handoff

## Completed

- Release branch: `singulance-main` at `a936b2694336ca07375a0a0862c93ab2493adbf6`.
- Durable Web Intelligence tables and API key ownership columns were applied directly with the idempotent SQL migration:
  `core/prisma/migrations/20260802170000_web_intel_durable_jobs/migration.sql`.
- Verified database objects: `hivemind.web_intel_jobs`, `hivemind.web_intel_usage_settlements`, `api_keys.key_kind`, and `api_keys.created_by_user_id`.
- Core validation passed:
  `npx prisma validate --schema prisma/schema.prisma`, `node --check src/server.js`, `node --check src/web/browser-runtime.js`, and Vitest Web/MCP suites: 30/30 passed.
- Frontend build passed in a clean Node 20 container after commit `732bcad9849b42d64f5c4409c90564fa3ae1ae91` fixed the missing `FileText` import.
- Immutable images are staged:
  - `hivemind/core-api:prod-20260802-a936b269`
  - `hivemind/control-plane:prod-20260802-a936b269`
  - `hivemind/fe:prod-20260802-a936b269-single`
- The frontend was released by the locked script and serves HTTP 200.

## Blocker

Another deployment replaced the live Core and Control Plane while the locked release was progressing. Live Core includes the new Web Intelligence source; live Control Plane does not contain `keyKind` or `web_research` API-key behavior. Its current source/image provenance is not represented by a clean committed SHA, so replacing it with the staged Control Plane image would overwrite unrelated work.

Do not force-recreate `hm-control`. First merge/commit the concurrent Control Plane work into `singulance-main`, replay the Web Intel API-key commit on that clean SHA, then build and release the merged source under `/run/lock/singulance-production-release.lock`.

## Exact Next Action

Create a clean merge commit containing the current Control Plane deployment changes and the Web Intel API-key changes, then deploy only `control-plane` through `scripts/release-singulance.sh` and run authenticated API-key and MCP canaries.

## Decisions

- Chose not to overwrite a concurrent Control Plane release because product source provenance is unknown and the user explicitly prohibited overwrites.
- Kept the frontend release because it passed its build and is backward-compatible with the existing API-key response shape; its new service-key fields remain inactive until the merged Control Plane is deployed.
