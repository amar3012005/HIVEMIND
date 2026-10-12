# TestFlight candidate — 12 October 2026

## Exact candidate

- Frontend: `a1af26e99f2ffc3e6c475df2b6f656ce343dbb08`, branch `codex/ios-testflight-frontend-20261012`.
- Includes latest web main `22b7e672` merged into the existing mobile design/native admission work.
- Native packaged frontend, not a remote website URL. Capacitor 8.5.3.
- Bundle: `com.singulancelabs.mobile`; existing team: `QXPT27D6M9`.
- New recovery: private API 401 requests authenticated bootstrap; no automatic renewal, permission expansion or inferred account selection.

## Verified

- Eleven authentication, native API and roster regression checks passed.
- Two native navigation/release-placeholder checks passed.
- Production React build and native packaged configuration checks passed.
- Signed arm64 Release device build succeeded. Code signature verified as Apple Development, team QXPT27D6M9.
- Signed Debug simulator build succeeded.
- Existing installed app: user signed in; observed AMAR/Wise with Runtime, Sofia Kim, Luca Hernández and Amira Patel. Native diagnostic employee response: JSON, HTTP 200, three profiles.
- User reports Runtime and Sofia history/switching work. This observation precedes installation of the new candidate.

## Pending — not release acceptance

- Exact candidate installed and running through Xcode on iPhone 18 Pro Max. Signed-in AMAR/Wise and all three employees remain visible after installation. Repeat history, switching, keyboard and artifacts checks on this exact candidate; phone coordinate control currently fails with noWindowsAvailable.
- Audible voice playback and microphone test; physical iPhone verification.
- User voice retest: a reply is produced but remains inaudible. Simulator Sound=1 and output=MacBook Pro Speakers were observed. Capacitor configuration already permits gesture-free playback. Exact audio fault remains unresolved; no speculative call-code change made.
- User clarifies ringback is audible, but employee speech is not; mobile web voice works. Current live native image is `hivemind/harness-chat:sha-d190bbb2c72e-bounded`, digest `sha256:02ebfce9556083c429b20b1806f07acc990ac7b4641b6a23157fe49f513dc242`. Voice component and Grok adapter source are unchanged versus 6db0a078. Current web main 22b7e672 is included in this iOS candidate.
- Debug-only native playback counters installed through the existing Capacitor WebView factory hook. Local Xcode confirms `[VoicePlayback] diagnostic initialized`. No call counters yet; another visible call is required. Captures only connection/packet/energy/playback aggregates, not audio, transcripts, addresses or credentials. Release rebuild succeeds and diagnostic strings are absent from the Release executable.
- App Store Connect app record and intended release version/build number.
- Distribution signing/Apple account setup. Available local identity is Apple Development; no Apple Distribution identity currently verified.
- Review collection/tracking and required-reason API inventory, including bundled native dependencies. Existing privacy manifest has an empty required-reason list and an explicit owner-review note; that is not privacy approval.
- Review encryption declaration and commercial/account deletion behavior.
- Demo account, reviewer contact, feedback email, beta description and What to Test.

## Draft beta copy

Description: SINGULANCE brings your company knowledge and AI team into one workspace. Work with Runtime and specialist agents through chat, voice, documents and connected apps.

What to Test: Sign in to your own workspace. Confirm the full team appears. Open Runtime and a specialist, load saved and older messages, switch between chats, type with the keyboard open, view an artifact, and try a brief voice conversation with audible playback. Report the action, expected result and observed result.

## Build outputs

- Device Release: `mobile-app/output/testflight-release/Build/Products/Release-iphoneos/App.app`.
- Simulator: `mobile-app/output/ios-testflight/Build/Products/Debug-iphonesimulator/App.app`.
- Local logs: `/tmp/testflight-device-release.log`, `/tmp/testflight-simulator-build.log`, `/tmp/testflight-auth-tests.log`, `/tmp/testflight-frontend-build.log`.

No TestFlight upload or approved distribution archive exists from this task yet. Do not fabricate `release-evidence.json`: the existing archive command requires actual physical-device and review evidence before distribution preparation.
