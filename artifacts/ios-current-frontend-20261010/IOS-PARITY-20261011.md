# iOS mobile parity repair

## Exact candidate

Packaged frontend: `a7a45a27c0c17eb7dc2ab3b65e1a4084def59864`, pushed on `codex/ios-chat-sidebar-parity-20261011`.
Includes latest recorded desktop sidebar identity/width and composer centering changes, the existing mobile page changes, and these native cold-start repairs:

- Mobile Brain Overview without a mounted native agent handler enters the employee Harness when selecting Runtime or a specialist.
- Native sidebar retries its roster after the existing signed ticket exchange when its OS runner-cookie jar is initially empty. HTML fallback is never interpreted as a roster.
- Roster and chat share concurrent admission; legacy rollout and denied ticket exchanges remain denied. No agent execution occurs during admission.

Existing Xcode project: `mobile-app/ios/App/App.xcodeproj`, scheme App, bundle `com.singulancelabs.mobile`, signing team QXPT27D6M9. Packaged local origin and native Keychain/trusted-frame/URL constraints are retained. No remote server.url configured.

## Production configuration repair

Current Control image `hivemind/control-plane:sha-2aa42338` had omitted `HIVE_MOBILE_RUNNER_CONSENT_READY`, causing authenticated native bootstrap to return 503 `MOBILE_RUNNER_NOT_READY`.
Verified actual runner image `hivemind/harness-chat:sha-acb3e8aad2-live-wait` compiled web-runner library contains native-session binding and fail-closed membership checks. Restored only that approved Control readiness key through its complete managed Compose configuration; kept the same image. Control returned healthy. All sibling container identities were checked unchanged.
Server release and rollback record: `/root/releases/ios-admission-recovery-20261011/release.json`; managed override `mobile-readiness.yml` beside it. Future Control releases must preserve this managed override after proving the matched runner consent capability, rather than silently resetting mobile admission.

## Verification

- Sidebar, native transport and loader: 11 focused checks pass.
- Employee route behavior: 13 checks pass.
- Shared admission, Harness surface, agent navigation and native transport: 19 checks pass.
- Native roster HTML fallback and denial: 2 checks pass.
- Production native-mode React build passed.
- Capacitor sync and packaged native guards passed.
- Signed Pro Max simulator xcodebuild passed: `/tmp/ios-roster-admission-native-build.log`.
- Simulator playback volume was 0; set to 0.7. Microphone input is MacBook Pro Microphone. Audible provider response still needs a live call check.

## Open acceptance gates

Final rebuilt app is being launched through Xcode. Do not infer success from build or API health. Verify the signed-in account roster, Runtime/specialist saved history and switching, keyboard/composer, voice input and audible output. Simulator touch automation fails `noWindowsAvailable`; macOS toolbar controls and screenshots work, so user-assisted phone taps are required.
No TestFlight upload, distribution archive, physical-device proof, Apple membership/App Store Connect review proof or store-readiness claim.
