# Authenticated CRM isolated preview evidence

All database identities, API keys, Redis sessions, and workflow receipt fixtures are synthetic. No production deployment, production secrets, production grants, external connector action, or live workflow execution is claimed.

The exact native Core and Control Plane HTTP processes run on an internal isolated Docker network against full-schema PostgreSQL 15.7 with Redis sessions. Latest combined-source verification: `72fafd3a4` includes the fixed-schema membership lock function, provisioned least-privileged `hivemind_app_runtime` role, forced RLS, and native authenticated HTTP mount. Image `hivemind/core-api:sha-7d4d5eb2` supplies runtime dependencies.

- `crm-authenticated-http-20261006.json`: 30 successful actual HTTP checks. Persisted API-key admission, signed Redis session cookie admission, native runner JWT verification, draft/validate/publish/reference records, idempotency, optimistic concurrency, tenant isolation, invalid/project scopes, member revocation across three admission paths, API-key revocation, and immutable published name.
- `crm-role-boundary-20261006.json`: five actual PostgreSQL checks. CRM credential fails identity table updates with SQLSTATE 42501; membership revocation waits for the admitted transaction lock then succeeds after release.
- Focused `app-runtime-contract.test.js` and `app-runtime-integration.test.js`: 10/10 pass. Combined with the exact native employee lifecycle file: 17/17 pass (7 employee tests).
- Full unit suite: 2,239 tests, 2,115 pass, 124 fail. Untouched `740bcb7da` baseline in the same image and synthetic environment: 2,234 tests, 2,110 pass, 124 fail. Top-level failing names are identical (117; nested tests account for total124). No new failures by name. This is not a clean full-suite pass.

Reproduction uses `crm-auth-seed.mjs` (private auth fixture), `crm-authenticated-http-demo.mjs` (SSH to named isolated fixture), and `crm-role-boundary-demo.mjs` (inside isolated container, guarded by `CRM_AUTH_PREVIEW=synthetic-only`). Private keys/cookies are never checked in. Both organizations remain active after revocation proof for browser/native tool verification. The marked HQ receipt is a projection fixture only, not workflow execution.

## Combined source retest

After applying the final employee operating-instruction prerequisite (`72fafd3a4`), both actual Core and Control Plane processes were restarted. All 30 HTTP checks, five PostgreSQL role/lock checks, and 17 focused tests passed again. Core behavioral source was the exact `66e2d946b` archive plus the only two Core files changed through `72fafd3a4` (employee lifecycle implementation and its test file). No CRM storage/auth/gateway delta existed. The full-unit baseline comparison above remains from the prior CRM source; it was not rerun for the employee delta.

## Fresh canonical reconciliation

The production candidate starts from exact canonical `17d9a9deed07b76056492351d87f31fc3bb11403` and replays CRM-only changes. Canonical employee code and outer frontend gitlink135a remain intact. At behavioral source `1bee2b7c4`, actual HTTP30/30, role5/5, and focused18/18 (CRM11 + canonical employee7) passed. An intermittent concurrent joined-lock read returned404; acquiring the app lock before reading its immutable version fixes the READ COMMITTED snapshot race. Twenty additional pairs of actual concurrent HTTP patches each returned exactly200/409, with no write retry.

Full unit comparison on the same isolated image/environment: canonical2234tests2110pass124fail; CRM2245tests2121pass124fail. All117top-level failing names match; no new failing names. This remains a non-green overall suite. No production schema/config/service changes were made during these proofs.
