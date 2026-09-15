---
name: identity-platform
description: Safely build user, organization, project, login, admission, usage, limits, and billing behavior for SINGULANCE.
---

# Identity platform workflow

Read `../../platform.yaml` and `../../capability-contracts.md` first.

1. Start at the authenticated Core identity, not a browser-provided user ID.
2. Resolve organization membership and authorized projects server-side.
3. Keep plan, usage, billing, and feature admission in typed Core records or the
   designated feature-flag service. UI is a projection, never authority.
4. For runner admission, issue a short-lived, signed, bounded ticket and verify
   origin, nonce, audience, user, organization, and expiry at the runner boundary.
5. Test authorized access, cross-user/organization denial, expired ticket,
   feature-flag off, and refresh/replay.
6. Release Core and Worker only when each actually changed; verify a signed-in
   browser against the canonical route.

Never copy authentication secrets between environments or infer billing state from
an old client session.
