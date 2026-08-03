# Workspace Admin

Status: released 2026-08-02

## Canonical behavior

Workspace administration is served through the Workspace Admin tabs for members,
teams, projects, invitations, and Cognitive Layer. The control plane derives the
organization and actor from the authenticated principal, requires an active
organization membership, and returns the same not-found result for an absent or
inaccessible administrative resource.

The authoritative workspace summary supplies active seats, pending invitations,
project and team counts, plan limits, remaining capacity, and warning state.
Workspace notifications are scoped to the current organization and recipient.
All mutations retain the existing append-only audit path.

## Release evidence

- `core/tests/unit/workspace-access-policy.test.js` and
  `core/tests/unit/workspace-cognition-contract.test.js`: 8 passing tests.
- Manual production SQL: `20260802100000_workspace_admin_gate` applied; verified
  `hivemind.workspace_notifications` exists.
- Core `hivemind/core-api:sha-251aaeaa6`, Control Plane
  `hivemind/control-plane:sha-251aaeaa6`, and frontend
  `hivemind/fe:sha-db7d54f` are running and healthy.
- Core and Control Plane `/health` returned `200`; local and public Workspace
  frontend canaries returned `200`.

## Remaining operational verification

The release has not yet run a signed-in browser matrix for multiple organizations
or a live remote `.amr` storage canary. Keep personal cognition participation
disabled until an individual consent control is exposed and verified.

## Promotions Release Evidence

Released `2026-08-03` from `0a280e53004bfe37e0fdba5859043433a79c3312`.

- Pilot organization grants remain organization-scoped and append-only audited.
- Active invitation and membership policy remains the prerequisite for every
  commercial entitlement read or mutation.
