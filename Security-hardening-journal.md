# HIVEMIND Security Hardening Journal

## 2026-07-10 - Privileged AI authorization

### Scope

- Restricted all user-facing HyperAgents routes to organization owners/admins, project owners, and team leads.
- Applied the same authorization rule to all TARA API routes in core.
- Kept internal HyperAgents callbacks outside the user-role gate; they retain service-key authentication.
- Added a focused permission regression test for allowed and denied roles.

### Evidence

- `node --check` passed for `permissions.js`, `control-plane-server.js`, and `server.js`.
- `node --test tests/unit/privileged-agent-permissions.test.js` passed: 2/2.
- Frontend production build completed successfully.
- `git diff --check` passed.

### Existing Debt

- `core/tests/unit/billing.test.js` predates the current plan contract and fails on old field names, prices, and feature assumptions. Update it from `core/src/billing/plans.js`; do not alter production plans to satisfy stale tests.
- Referral entitlements and hardened internal-service authentication exist on `codex/production-hardening-runtime` but are not merged into `feat/mneme-foundation`. Reconcile branches before deployment instead of reimplementing them here.

### Next Phase

Merge or rebase onto `codex/production-hardening-runtime`, then verify referral onboarding, entitlement phase transitions, per-feature usage gates, and tenant-scoped project access end to end.
