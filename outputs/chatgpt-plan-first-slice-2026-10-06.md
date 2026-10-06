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
