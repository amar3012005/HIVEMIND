# Mobile release progress

Updated 8 October 2026. This record is implementation evidence, not store readiness signoff.

## Verified in source

- Responsive layouts, safe-area and keyboard sizing, mobile touch targets, secondary voice controls and consumption-only native billing screens.
- Secure PKCE authorization through the system browser, OS credential storage, replay protection, dedicated revocable native sessions and native-only API proxying. Auth browser fixtures use real WebCrypto with a mocked OS plugin/server.
- Durable explicit AI consent, user-supplied safety reports and passkey-authenticated operator triage. 24 focused backend checks pass.
- Native clients do not receive a broad Core API key.
- Public account deletion instructions and corresponding React server rendering.
- DSH transport authority treats a packaged localhost client as a remote host. Two focused tests pass with full helper coverage; the connection package compiles.

## In progress

- Native DSH boot/module loading, authenticated streams, attachments and downloads.
- Consent withdrawal and revocation after Runner admission; CP admission checks alone are insufficient.
- Android plugin build and focused trust-boundary checks.
- Integrated builds, scoped deployment and authenticated route/device verification.

## Release state

The mobile source changes have not been deployed or submitted to stores. A prior mobile composer runner image is built; a ten-minute idle guard declined its cutover because Runtime work remained active. Another guarded wait is running; consult its release log before starting any overlapping cutover.

## External gates

Apple/Google account ownership is awaiting the administrator's answer. iOS compilation requires the supported Xcode toolchain on a Mac. Signing, physical device checks, final provider/privacy declarations, store tester/reviewer access and store review remain unverified. No passwords or signing keys should be pasted into chat.
