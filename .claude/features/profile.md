# Profile Production Gate

Released on `2026-08-03` from `72e2448bc3601cd48d0e377cab4b6c517d95ca4c`.

- Personal identity remains user-owned while organization context and commercial authority are membership-derived.
- Tenant derivation is centralized in `TenantAccessService`; callers do not supply organization or user identity.

## Promotions Release Evidence

Released `2026-08-03` from `0a280e53004bfe37e0fdba5859043433a79c3312`.

- Organization account profiles now distinguish `personal`, `enterprise_managed`,
  and `enterprise_self_hosted`; compatible hosting and storage are validated
  server-side during promotion grant or redemption.
