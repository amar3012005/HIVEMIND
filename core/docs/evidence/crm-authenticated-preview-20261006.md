# Authenticated CRM isolated preview evidence

All database identities, API keys, Redis sessions, and workflow receipt fixtures are synthetic. No production deployment, production secrets, production grants, external connector action, or live workflow execution is claimed.

The exact native Core and Control Plane HTTP processes run on an internal isolated Docker network against full-schema PostgreSQL 15.7 with Redis sessions. Source `a08c4b485` includes the fixed-schema membership lock function, provisioned least-privileged `hivemind_app_runtime` role, forced RLS, and native authenticated HTTP mount. Image `hivemind/core-api:sha-7d4d5eb2` supplies runtime dependencies.

- `crm-authenticated-http-20261006.json`: 30 successful actual HTTP checks. Persisted API-key admission, signed Redis session cookie admission, native runner JWT verification, draft/validate/publish/reference records, idempotency, optimistic concurrency, tenant isolation, invalid/project scopes, member revocation across three admission paths, API-key revocation, and immutable published name.
- `crm-role-boundary-20261006.json`: five actual PostgreSQL checks. CRM credential fails identity table updates with SQLSTATE 42501; membership revocation waits for the admitted transaction lock then succeeds after release.
- Focused `app-runtime-contract.test.js` and `app-runtime-integration.test.js`: 10/10 pass.
- Full unit suite: 2,239 tests, 2,115 pass, 124 fail. Untouched `740bcb7da` baseline in the same image and synthetic environment: 2,234 tests, 2,110 pass, 124 fail. Top-level failing names are identical (117; nested tests account for total124). No new failures by name. This is not a clean full-suite pass.

Reproduction uses `crm-auth-seed.mjs` (private auth fixture), `crm-authenticated-http-demo.mjs` (SSH to named isolated fixture), and `crm-role-boundary-demo.mjs` (inside isolated container, guarded by `CRM_AUTH_PREVIEW=synthetic-only`). Private keys/cookies are never checked in. Both organizations remain active after revocation proof for browser/native tool verification. The marked HQ receipt is a projection fixture only, not workflow execution.
