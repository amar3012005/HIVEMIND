# Settings Production Gate

Released on `2026-08-03` from `72e2448bc3601cd48d0e377cab4b6c517d95ca4c`.

- Workspace-level commercial and destructive settings are constrained by the same active membership and owner/admin policy.
- Billing UI cache is cleared on tenant switch, preventing stale shared allowance display across organizations.

## Promotions Release Evidence

Released `2026-08-03` from `0a280e53004bfe37e0fdba5859043433a79c3312`.

- Commercial configuration is platform-admin-only through the dedicated admin
  host; material entitlement changes append a new version rather than rewriting
  historical commercial terms.
