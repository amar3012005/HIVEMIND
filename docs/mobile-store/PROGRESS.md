# Mobile release progress

Updated 8 October 2026. This record is implementation evidence, not store readiness signoff.

## Completed and verified

- Cloudflare frontend 49ac21c2 is deployed as Worker 0466550c-3a68-495d-84a7-1494417ad7c4. Signed-out mobile and account-deletion pages were checked at 320, 390 and 768 pixels: no horizontal overflow or page errors.
- Control Plane 5b7f0780 is deployed and healthy. Native authorization, explicit AI consent, safety reports, revocable sessions and a default-disabled Runner readiness gate are implemented; 35 focused backend tests pass.
- Native OS credential storage, bounded HTTP/WebSocket transport, packaged module loading, downloads, logout isolation and account-switch consent handling are implemented. Browser fixtures exercise the real compiled frontend with mocked native boundaries.
- Android debug APK includes the real compiled frontend 49ac21c2, not the placeholder. Build, unit and lint checks passed. Artifact: /root/releases/mobile-store-native-artifacts/singulance-49ac21c2-debug.apk; SHA256 bbbbf46c91c340095f74864514f569f8fa06c4242ccf1f5ef35a8dd774e30906. It is a test build, not a store-signed release.
- An unsigned Android AAB is also prepared at /root/releases/mobile-store-native-artifacts/singulance-49ac21c2-unsigned.aab; SHA256 c124e962db43e3db354fd52e079ba7e687b976a474e22f2fb458c92b2ae4c319. It excludes debug fixtures and contains no signature. It cannot be uploaded as a signed release.
- Reduced-motion page transitions, landscape layout and enlarged-text browser checks passed. Native release evidence now requires all recorded DSH feature gates, the exact frontend SHA and physical-device/platform information.
- Runner image hivemind/harness-chat:sha-8b119aea-mobile-store is built from pushed source 8b119aeadf7036d15b3e90dac70b67c8c29a6d90. Both image profiles, full pre-push checks and 22 focused checks passed. Source delta accounts for all 17 changed paths from the live base.

## Concrete deployment blocker

The runner remains on sha-40b0561a1e-anticipatory-cumulative: its authenticated idle probe reports one active turn. Earlier bounded waits declined deployment. The final ten-minute idle guard for 8b119aea ended with exit code 4 and no deployment; active_turns remained 1. No cutover process is running. Its log is /root/releases/mobile-store-runner-8b119aea/cutover.log. Deployment requires two idle observations and changes only the runner. Do not interrupt active work or enable native Runner readiness before matched admission and consent verification. Consult the log and Docker revision before treating this record as current deployment status.

## Remaining verification and external gates

- Authenticated mobile chat, consent withdrawal/revocation on the deployed Runner, attachment and download interactions on real devices.
- iOS compilation on supported Mac/Xcode, signing and physical-device testing. Linux emulator boot did not reach a usable system; no instrumentation success is claimed.
- Apple Developer and Google Play Console ownership, final privacy/provider declarations, reviewer access, signed release packages and store submission/review.

No native app was distributed and no store submission or overall readiness signoff occurred. Existing web Runtime work remains preserved.
