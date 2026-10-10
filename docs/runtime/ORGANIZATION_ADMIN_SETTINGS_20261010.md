# Organization settings release

## Scope and semantics

The existing platform dashboard at `admin.hivemind.singulancelabs.com` gains an
Organizations section. Its API is
`GET/PATCH /admin/api/platform/organizations/:uuid/settings`, authenticated by the
existing signed platform-admin cookie. Organization owners/admins cannot use it.

Included credits change the shared allowance; remaining credits still deduct
historical consumption and reservations. No usage rows, purchases, grant history
or organization plan are rewritten. Existing monthly versus grant-lifetime pool
semantics remain authoritative. Seat limits include active members and pending
invitations. Blank controls inherit the commercial plan/grant, `-1` is unlimited,
and `0` stops new usage. Existing work is not cancelled.

Only existing enforced capabilities are editable: Agent Swarm and company
dreaming. These controls do not provide connector credentials or new user roles.
Expired, suspended, revoked or manual-review entitlement states remain restricted.

## Ordered release

1. Integrate the backend commit and frontend gitlink onto the current canonical
   release, preserving other changes. Build current matched Core/Control images.
2. Before starting either new image, apply
   `core/prisma/migrations/20261010233000_organization_policy_versions/migration.sql`
   using the managed database migration procedure. It creates an append-only
   organization-scoped version table; no existing balances or usage change.
3. Confirm the actual Core/Control database role can SELECT/INSERT this table.
   The migration grants those operations to the current `hivemind_user` role,
   grants no UPDATE/DELETE or PUBLIC access, and grants nothing to the runner.
   If deployment uses a different role, resolve that explicitly before cutover.
4. Deploy both backend services through the managed release lock. They must share
   the effective-plan resolver. Preserve existing images for rollback and current
   memory/security/environment settings. No runner release is required.
5. Release the frontend through the `hivemind-fe-deploy` guide and its guarded
   Worker release. The admin UI extends PlatformAdmin rather than replacing it.

## Focused acceptance evidence

- Unit tests cover strict input, platform-only authorization, organization scope,
  historical credit usage, seat minimum, effective feature/limit resolution,
  zero quotas, failure isolation and stale-edit conflict.
- Real isolated PostgreSQL proof covers migration, persistence, concurrent edits,
  cross-organization reads and append-only restricted-role privileges.
- Four UI tests cover current usage, saving with organization/revision,
  inheritance/reload and conflict feedback. Panel and existing admin page JSX
  compile. The final guarded frontend build belongs to the release owner.

Production verification must use an explicitly authorized fictional organization:
save an allowance and seat/capability override, reload and read it back; verify
credits deduct existing usage/reservations; deny the next admission at a consumed
quota/seat cap and deny a disabled capability. Test missing platform cookie and
organization-owner cookie denial, verify another organization remains unchanged,
then restore the original overrides using the new revision. Do not grant credits
or change real-user limits for a smoke test.

## Rollback and failures

Restore previous backend images and frontend release together if necessary. Leave
the additive version table intact; old code ignores it. New settings cease to
override admission on old code, so record any applied policies before rollback.
No historical consumption restoration is necessary. An unavailable policy table
produces a service error rather than silently discarding organization restrictions.
Optimistic revision conflicts require reloading before another save.
