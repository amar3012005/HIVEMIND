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

## Silent speech trace and repair candidate

User repeated the call; native counters show connected=1, inbound audio packets rising 59 → 294 → 533, bytes 9581 → 33565 → 50773, nonzero energy 0.16941 → 0.46380; HTML media playing=1, muted=0, ready=1; runningContexts=1. Ringback audible; employee speech inaudible. This proves delivery of nonzero audio to the iOS client, not audible rendering.

Native repair e316e6aa0ba43a762b7aa21ec8b241a2b66f3a89 builds from exact live d190bbb2c72e. Routes provider stream to a gain-controlled output in the already running Web Audio activity context, only for capacitor: pages. The microphone remains analysis-only. Mutes the old media element to avoid duplicate output; speaker controls operate the native gain; navigation releases nodes/context. Browser HTML playback remains unchanged. Eleven focused voice checks, normal commit checks and full push typechecks pass.

Deployed image: `hivemind/harness-chat:sha-e316e6aa0ba4-ios-voice-playbacks`, digest `sha256:c2da118fc6b65a8fc0cb8c9f92a1965a4d4f775e977b2fc29451e1d08ca9bf72`. Actual image retains existing presets/plugins and compiled native speaker route. Managed runner-only cutover reports healthy; sibling container identities preserved. Rollback: `/root/releases/ios-voice-playback-e316e6aa0ba4/rollback-image.json`. Simulator app restarted to load new plugin revision.

Postrelease: user hears Sofia's spoken introduction. Native counters show nonzero intro audio energy; media element muted=1 confirms the new Web Audio route owns output. Subsequent inbound packets continue but energy remains flat; user reports speaking without a further audible reply. Two-way voice acceptance is still open. Debug-only outgoing packet/microphone-energy counters are installed and initialized for the next call. Native mute/unmute and physical-device acceptance remain pending.
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

## TestFlight account check — 13 October 2026

Xcode Apple Accounts shows only the existing Personal Team, with On Device Testing and one provisioned device. No paid distribution team is visible yet. User will sign in to their paid team. Keep the existing app signing configuration until the actual paid team ID and bundle access are verified. Signed Release signature verification and native packaged checks pass; this is not an uploaded TestFlight build.

The installed microphone diagnostic has initialized, but no outgoing microphone counters have been captured from the subsequent test yet. Intro playback is verified; two-way voice remains open.
