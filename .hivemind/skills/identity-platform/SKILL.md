---
name: identity-platform
description: Build or repair user, organization, project, login, usage, billing, admission, and lifecycle behavior.
---

# Identity platform

Use for identity and lifecycle ownership. Derive authorization from authenticated server claims and
membership, never browser-entered identifiers. Keep plan/usage enforcement independent from a UI
surface feature flag unless the product contract explicitly joins them.

Lifecycle triggers must be durable and idempotent. A browser may render status but must not be the
sole owner of an irreversible background transition. Verify both authorized and denied paths.
