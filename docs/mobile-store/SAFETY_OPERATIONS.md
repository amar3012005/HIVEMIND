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
