# Billing Production Gate

Released on `2026-08-03` from `72e2448bc3601cd48d0e377cab4b6c517d95ca4c`.

- Organization entitlement is authoritative; `Organization.plan` remains a compatibility projection.
- Owners and admins manage checkout, portal, reconciliation, invoices, and commercial changes.
- Members can read the shared plan and allowance but receive no Stripe identifiers or invoice access.
- Public health canaries returned HTTP 200 for product, frontend, Control Plane, and Core.
