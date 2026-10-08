# Native AI consent and report operations

Source implementation, not production certification.

Native CP sessions are explicitly marked `nativeMobile` by the PKCE session-grant endpoint. Before native `/v1/harness-chat/*`, `/v1/proxy/*` (except health), and chat/research/voice/company-AI namespaces, Control Plane checks the latest authenticated user's `mobile.ai_consent` AuditLog record. Consent must be granted for the current disclosure version. Missing/withdrawn/stale consent is403; database failure is503. Browser sessions remain unchanged. Profile, basic onboarding, privacy choice, account deletion and authentication remain accessible. Deleting an existing Harness session does not require AI permission.

Native `/v1/bootstrap` supplies `session_api_key:null` and does not call broad Core API-key provisioning. The native app uses its dedicated CP session and authenticated proxy; this does not make unrestricted Core access a native feature.

## Operator safety inbox

Use the existing authenticated **platform passkey session**, not a tenant administrator credential:

- `GET /admin/api/platform/mobile-safety-reports`: at most50 reports, current append-only triage state and `next_cursor`.
- `GET ...?before=<next_cursor>`: older reports.
- `POST /admin/api/platform/mobile-safety-reports/<report UUID>` with `{ "status": "reviewing"|"resolved"|"dismissed", "note": "10–2000 character review note" }`: appends a durable operator action referencing the original report. No report overwrite and no automatic email.

The operator should investigate the reported output, distinguish policy violations from normal inaccuracies, retain relevant evidence with appropriate access controls, and use confirmed findings to improve configured prevention/moderation. A “resolved” receipt records a review decision; it does not itself change model filters or delete user content. Assign a monitored owner and review cadence before launch. Do not include private credentials or unrelated company data in review notes.

## Remaining proof boundary

The CP guard blocks new native admissions and proxy calls. **Already-issued Runner cookie grants do not carry a mobile-consent marker in the current Harness ticket/connection contract.** Therefore immediate withdrawal enforcement for a previously established Runner gateway requires a native-specific transport/principal check or scoped grant revocation in Runner. Do not claim complete withdrawal enforcement until that seam and the physical-device tests pass. Grant/session/permission changes must preserve web tenant behavior and native deliberate-Stop/approval boundaries.

## Signed Runner consent seam implemented in source

The previous cookie-marker gap is addressed by optional `native_session_hash` admission claims. CP derives the hash from the authenticated native session; clients cannot select it. The signed cookie principal and Runner service JWT retain that binding without putting a raw CP session token into tickets. Existing Runner RPC guard revalidates the signed principal through the existing CP service boundary on every request, with no positive cache. CP checks the hash-indexed live native session, exact user/org and current durable consent before allowing the signed principal or any downstream signed Core proxy request. Native ticket exchange and boot additionally use this check. Web principals without the marker remain unchanged.

Withdrawal, logout/revoke, session expiration and organization switch therefore deny subsequent commands from an old native Runner cookie. Root's native organization mutation preserves the CP token and its Redis TTL while updating authoritative membership scope; old-org cookies are denied. Requests already admitted and data already transmitted cannot be recalled; this change does not claim forced cancellation of an in-flight external operation. Full device/Runner rollout and transport verification remain pending.

Focused source evidence: signed marker validation, consent withdrawal after a previously valid grant, revoked session, changed org, actor mismatch, Redis outage and unchanged web behavior. Runner's standalone boundary checks passed using Node22 type stripping; full package compilation/release remains an integration gate.

Additional integration evidence (8 October 2026): Harness commit `29f2a9a8` exercises the real Runner `apply` exchange handler, verifies the marker survives an actual `BrowserAuth.authorizePrincipal` cookie and `principal` round trip, and inspects the actual private service-token output on subsequent RPC guards. All three emitted tokens retain the binding and have valid HMAC signatures. A later denied authorization response rejects the next RPC without a positive cache. Redis and the service HTTP response are controlled test fixtures; this proves source transport propagation, not production deployment.

A separate resource-limited disposable Redis instance exercised the actual Core session store and grant index: current consent admitted the native principal; withdrawal denied it; renewed consent admitted it; deleting its CP session denied it. The instance was stopped after the check. Browser/device transport, deployed service configuration and store submission remain separate gates.
