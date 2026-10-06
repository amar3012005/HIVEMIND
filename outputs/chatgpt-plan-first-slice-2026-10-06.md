# Current implementation status — 2026-10-07

The first-slice notes below are historical. Registered hosted OAuth lifecycle code now exists: persisted owner-bound PKCE/state/nonce attempts, one-time callback consumption, RSA/EC JWKS verification, account catalog, rotating refresh, local/remote disconnect, status, selection and native automatic root-Brain routing. Connection controls and the native bridge are being integrated by the release owner. No HIVEMIND billing-system integration, checkout, usage ledger or subscription changes were added.

The real hosted client registration and production activation remain absent. All successful provider tests use explicitly fake grants and loopback HTTP providers; there is no successful real ChatGPT plan request or Cloudflare canary.

## Current verification and boundaries

14 Core tests pass, including fixture HTTP OAuth/JWKS/catalog/refresh/revocation, cross-owner and replay denial, expiry/member revocation, malformed identity and native root-room eligibility. Native tests cover selected-model routing and opt-in fallback with no splice after visible output, denied-owner refusal and recursion protection. PostgreSQL schemas validate with Prisma 5.22; two migrations are staged and unexecuted. Mock transactions serialize fixture calls but do not prove PostgreSQL locking.

OAuth configuration requires the issued HIVE_CHATGPT_PLAN_CLIENT_ID, exact HTTPS HIVE_CHATGPT_PLAN_REDIRECT_URI, registered HIVE_CHATGPT_PLAN_AUTHORIZATION_URL/TOKEN_URL/JWKS_URL/REVOCATION_URL on auth.openai.com, HIVE_CHATGPT_PLAN_TOKEN_AUTH_METHOD (none or client_secret_post), optional required client secret, separate vault secret and explicit approval/enabled gates. No dynamic local client is accepted for hosted deployment.

Core service-authenticated API prefix: /internal/v1/harness-chat/core/chatgpt-plan/connection. GET status; POST start, callback {state,code}, models, select {model,platform_fallback}, disconnect, and route {session_id}. Browser requests use the native same-origin bridge; it derives ownership from the authenticated session and never accepts owner IDs or credentials from the browser. The callback URI must be the configured Brain overview URL handled by that authenticated UI. Token callbacks return only connection/model metadata.

Core status distinguishes disabled approval, missing endpoints/client/auth configuration and active connection. Native provider discovery advertises actual account models plus auto; automatic dispatch checks the persisted exact-owner root Brain preset. Runtime, employee, child, scheduled and unauthenticated execution do not gain plan credentials. Those future routes require explicit sponsor ownership and permission propagation.

Platform fallback requires the user's stored opt-in and a configured existing native platform route. It is limited to eligible provider failures before any streamed output, never owner/member/session denial, cancellation or already emitted tool blocks. No automatic token retry or cross-provider replay of executed tools occurs. A late failure after visible text remains an explicit failed turn rather than duplicating output with another provider. Media, voice, Dreamer and Core's other model consumers are untouched.

Remaining activation work: issued hosted contract/config; real OAuth consent and account-specific catalog; gateway/provider completed inference and limit behavior; PostgreSQL migrations and actual lock/race verification; guarded deployment and authenticated browser canary. No production configuration or existing Codex grants were touched.

---

# Gated ChatGPT-plan Brain integration

This is an implemented first slice, not an enabled connection or a complete OAuth feature. OpenAI hosted-plan approval is confirmed absent. No production settings, existing Codex grants or provider accounts were touched.

## Implemented

- Separate org/user encrypted plan grant vault, AES-256-GCM with owner and registered-client AAD. Existing connector storage is untouched.
- Trusted callback storage seam requires matching client/issuer, plan scope and bounded account model allowlist. No public token-upload endpoint is provided. ID-token verification must happen in the future OAuth callback before invoking this seam.
- Every inference resolves membership, exact persisted owner and root Brain preset. Runtime, employee and child sessions are excluded.
- Core broker owns decryption; grant does not enter runner/tool/session events. Correct Cloudflare OpenAI /openai/responses URL, distinct gateway/user bearers, no platform BYOK alias or cache.
- Gated native provider uses native LlmAdapter/StreamChunk, preserves text/function history, waits for completed responses before releasing executable tool blocks, handles late failure and CRLF SSE framing. Plain-text/function tools only in this slice; unsupported attachments fail explicitly.
- Generic transaction/row-lock refresh seam and local disconnect. Refresh requires an injected registered-client implementation; no endpoint or client approval is fabricated. Local disconnect clears grant material; remote revocation remains separate.
- Both Core approval+enabled gates and native config default disabled. Existing platform model selection unchanged.

## Not implemented/activated

OAuth start/callback/ID-token verification, hosted client issuance, actual refresh HTTP client, provider revocation, browser connection/usage UI, per-account catalog fetch, automatic model selection, platform fallback policy, Runtime/company sponsor/delegation/schedules, media or voice routes. No real plan inference was attempted. PostgreSQL migration is staged only and has not been applied or exercised against a database. Tests use isolated fake grants/providers and mocked transactional storage; they do not certify hosted eligibility or gateway/provider billing.

## Registration package required before activation

Obtain hosted commercial plan approval, issued client ID and exact HTTPS callbacks, issuer/JWKS/authorization/token endpoints, token endpoint auth method (public or confidential), plan-usage scopes, refresh/revocation behavior and supported account-model contract. Confirm whether background/company-sponsored work is permitted separately. Identity-only OAuth permission is insufficient.

Key configuration is server-only: HIVE_CHATGPT_PLAN_CLIENT_ID, HIVE_CHATGPT_PLAN_ENCRYPTION_KEY (64 hex characters, separate secret), HIVE_CHATGPT_PLAN_APPROVED and HIVE_CHATGPT_PLAN_ENABLED. Native chatgptPlanBrainEnabled defaults false. Do not enable any gate before approval, OAuth verification and completed direct+gateway canaries. No secrets belong in chat or source.

## Verification

7 Core tests: encryption/isolation/client binding, approval/membership/session restrictions, identity-only/expired/model rejection, request allowlist, exact gateway URL/bearer behavior, mocked refresh rotation/disconnect, malformed metadata.
6 native tests: history/system ordering and field mapping, split CRLF/final-only text, completed tool vs failed stream, truncation/media rejection, principal transport/attribution, missing session rejection. Native web-runner TypeScript compilation passes.

## Running isolated Cordis/HTTP preview

The native opt-in `chatgpt-plan-http.spec.ts` starts actual loopback broker and SSE provider servers. A real Cordis Context and native LlmRuntime register the same `registerBrainPlan` helper used by web-runner. Native streaming then traverses HTTP to the Core broker and a second HTTP fixture upstream. Assertions cover service JWT signature/org/user, persisted session ownership, exact documented gateway URL, separate user/gateway bearers without BYOK alias, delayed completed response, one executable function block, usage, and an unowned session rejection before upstream access. Disabled native registration is checked first.

All credentials, client approval and upstream responses in this smoke are explicitly fixtures. It does not call Cloudflare or OpenAI, does not boot the complete Redis-backed web-runner, and does not verify the production service authentication middleware or real OAuth eligibility. The broker handler and native LLM service are real source modules. In-memory storage is used; Docker is installed but its daemon is unavailable and psql is absent, so PostgreSQL migration execution and lock concurrency remain unproved.

Reproduce in the native worktree (Node on PATH):

```sh
HIVE_PLAN_SMOKE_CORE_SOURCE=/private/tmp/hivemind-chatgpt-scoped-brain-20261006 node node_modules/vitest/vitest.mjs run packages/hivemind/web-runner/tests/chatgpt-plan.spec.ts packages/hivemind/web-runner/tests/chatgpt-plan-http.spec.ts
```

7 native tests pass including the running HTTP smoke; 7 Core tests pass; web-runner TypeScript and Prisma 5.22 schema validation pass. Broader Core gateway/harness suites have seven failures also reproduced by the release owner at unchanged parent baseline: six missing `@prisma/client` dependency and one existing bootstrap fixture mismatch. No broad-suite success or production integration claim is made.
