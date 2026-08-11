# Billing Production Gate

Released on `2026-08-03` from `72e2448bc3601cd48d0e377cab4b6c517d95ca4c`.

- Organization entitlement is authoritative; `Organization.plan` remains a compatibility projection.
- Owners and admins manage checkout, portal, reconciliation, invoices, and commercial changes.
- Members can read the shared plan and allowance but receive no Stripe identifiers or invoice access.
- Public health canaries returned HTTP 200 for product, frontend, Control Plane, and Core.

## Promotions Release Evidence

Released `2026-08-03` from `0a280e53004bfe37e0fdba5859043433a79c3312`.

- `Promotion`, immutable promotion/entitlement versions, eligibility, redemption,
  and organization account profiles are live in the `hivemind` schema.
- `resolveEffectiveEntitlement(orgId)` now gives active promotion grants priority
  over legacy plan projections; expiry moves pilots to manual review.
- `admin.hivemind.singulancelabs.com` is TLS-enabled and the protected commercial
  API returns credentialed CORS headers and `401` without a passkey session.
