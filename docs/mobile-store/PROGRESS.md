# Mobile release progress

Updated 8 October 2026. This record is implementation evidence, not store readiness signoff.

## Completed and verified

- Cloudflare frontend 12f169fe is deployed as Worker c3e63a97-146c-4e5b-b148-559f5e174683. Signed-out mobile and account-deletion pages were checked at 320, 390 and 768 pixels: no horizontal overflow or page errors.
- Control Plane 5b7f0780 is deployed and healthy. Native authorization, explicit AI consent, safety reports, revocable sessions and a default-disabled Runner readiness gate are implemented; 35 focused backend tests pass.
- Native OS credential storage, bounded HTTP/WebSocket transport, packaged module loading, downloads, logout isolation and account-switch consent handling are implemented. Browser fixtures exercise the real compiled frontend with mocked native boundaries.
- Android debug APK includes the real compiled frontend 12f169fe, not the placeholder. Build, unit and lint checks passed. Artifact: /root/releases/mobile-store-native-artifacts/singulance-12f169fe-debug.apk; SHA256 1de12e56c0557436ebe27bf183193e4d22bbee82dc8f0d33a478827b02e9a6a3. It is a test build, not a store-signed release.
- Runner image hivemind/harness-chat:sha-8b119aea-mobile-store is built from pushed source 8b119aeadf7036d15b3e90dac70b67c8c29a6d90. Both image profiles, full pre-push checks and 22 focused checks passed. Source delta accounts for all 17 changed paths from the live base.

## Concrete deployment blocker

The runner remains on sha-40b0561a1e-anticipatory-cumulative: its authenticated idle probe reports one active turn. Earlier bounded waits declined deployment. A new bounded idle guard for 8b119aea is running; its log is /root/releases/mobile-store-runner-8b119aea/cutover.log. Deployment requires two idle observations and changes only the runner. Do not interrupt active work or enable native Runner readiness before matched admission and consent verification. Consult the log and Docker revision before treating this record as current deployment status.

## Remaining verification and external gates

- Authenticated mobile chat, consent withdrawal/revocation on the deployed Runner, attachment and download interactions on real devices.
- iOS compilation on supported Mac/Xcode, signing and physical-device testing. Linux emulator boot did not reach a usable system; no instrumentation success is claimed.
- Apple Developer and Google Play Console ownership, final privacy/provider declarations, reviewer access, signed release packages and store submission/review.

No native app was distributed and no store submission or overall readiness signoff occurred. Existing web Runtime work remains preserved.
