# Trusted packaged mobile transport

`SingulanceNative` is a local Capacitor plugin, registered by MainActivity on
Android and SingulanceViewController on iOS. Its TypeScript contract is
`src/native-bridge.d.ts`. Frontend code imports Capacitor's `registerPlugin`; it
must not patch global fetch or expose this transport to artifact frames.

## Credentials

Only `pendingAuth` and `cpToken` keys exist. Android encrypts values with an
AES-GCM key held by Android Keystore; only ciphertext and IV are persisted.
iOS stores values in Keychain using WhenUnlockedThisDeviceOnly accessibility.
Removing `cpToken` clears Runner cookies and cancels active native requests and
streams. No localStorage/sessionStorage token fallback exists in the plugin.

The caller owns state/PKCE lifecycle. The plugin does not interpret callback
URLs or trust URL tokens. A valid code must be exchanged at the authenticated
Core mobile endpoint with the saved verifier and state. The returned token is
stored using setCredential. Its lifetime/revocation remain server-owned.

## HTTP

- HTTPS only, exact `api.singulancelabs.com` or `next.singulancelabs.com`.
- Core paths: `/auth/mobile/*` and `/v1/*`.
- Runner paths: `/api/*`; static `/plugins/*` and `/assets/*` are GET/HEAD only.
- Userinfo, fragments, nonstandard ports, encoded traversal and arbitrary hosts
  are rejected. HTTP redirects are never followed.
- Caller headers: Accept and Content-Type only. Authorization, Cookie, Host and
  Origin cannot be supplied by JavaScript.
- `authorize: true` injects the stored CP token only to Core. With no token it
  returns HTTP 401 / `signed_out`, rather than claiming the service is down.
- Runner requests set `Origin: https://next.singulancelabs.com` at the native
  network boundary and use the private remote cookie jar. This does not grant
  Host ownership, loopback access or any additional tool authority.
- Returned headers include only Content-Type, Content-Length,
  Content-Disposition and Retry-After. Set-Cookie remains native-only.
- Request body: UTF-8 or base64, maximum 8 MiB decoded. Response: text or base64,
  maximum 20 MiB. Large inputs fail rather than being truncated. Binary multipart
  callers must serialize an actual FormData request including its generated
  boundary, then send the resulting bytes with bodyEncoding base64.

## User-initiated file saving

`saveFile({name,mimeType,dataBase64})` opens Android's document picker or iOS's
export document picker. It accepts a basename and bounded file bytes, never an
arbitrary path/URI. Android writes only to the content URI granted by the OS
picker. iOS uses a protected temporary file and deletes it after the export or
cancellation. No broad storage permission is requested. The decoded file cap is
20 MiB and cancellation returns `{saved:false}`. Frontend download actions must
invoke this method instead of relying on WebView Blob-download anchors.

## DSH streaming

The active Harness source at `28f65228d8` declares
`REMOTE_STREAM_MUX_PATH = '/api/remote.mux'`. The plugin opens only
`wss://next.singulancelabs.com/api/remote.mux`, attaches native Runner cookies,
and sends the existing `{type:'open',streamId,endpoint,payload}` frame.

It emits raw JSON server frames as `streamEvent` type `frame`; the existing DSH
adapter validates and decodes item/end/error frames into AsyncIterable values.
Close cancels the logical stream / physical connection. No alternative stream
protocol, tool execution layer or scheduler is implemented.

At most 32 sockets and an 8 MiB frame are accepted. Stream IDs and endpoint
segments are validated, and socket destination is not caller-configurable.

## Artifact isolation

The plugin rejects remote/dev-mode WebViews. Android requires Capacitor's
modern origin-scoped WebMessageListener and removes the legacy all-frame
JavaScript-interface fallback. iOS wraps the WK native message boundary to
reject non-main-frame or non-local messages before Capacitor dispatch. Checking
only the top-level WebView URL would not suffice to reject a hostile iframe.

The frontend must keep `remoteHost` true / Host ownership false in its DSH
transport and keep the existing artifact sandbox. Authenticated network access
must not be mistaken for ownership of the Runner filesystem.

## Evidence / limits

Android debug compilation, URL-policy JUnit tests, native static guards and lint
have passed on the Linux builder. They do not demonstrate secure storage,
permission/OAuth return, WebSocket cookies or iframe rejection on a device.
Swift is added to the Xcode target and inspected against the installed Capacitor
interfaces; iOS compilation still requires macOS/Xcode. Both platform device
checks and the packaged frontend/API end-to-end flow remain release gates.

### Cookie isolation

Core HTTP calls never read or write cookies: their only credential is the explicitly injected OS-protected Bearer token. Runner cookies are held in a separate native memory jar and accepted only from `next.singulancelabs.com` with that exact cookie domain. Ancestor-domain cookies are rejected, so a Core response cannot shadow a fresh Bearer token or supply a Runner session. The same Runner jar authenticates its HTTPS calls and WebSocket. Signing out clears the jar; restarting the application requires establishing a fresh Runner session.

Android debug instrumentation includes a test-only packaged page for real Keystore round trips, sandbox iframe denial, and system document picker cancellation. This fixture is under the debug source set and is excluded from release APKs. Emulator evidence supplements physical-device and iOS checks; it does not establish OAuth, microphone, signing, or store readiness.

Verification on 2026-10-08: Android debug application and instrumentation APK compile, six JVM policy tests pass, and configuration guards pass. An isolated Android 15 software emulator was attempted without host KVM. It exposed adb before package services were ready, then property retrieval timed out during startup; no instrumentation test reached execution. The emulator was stopped and its downloaded image/tool removed when concurrent release builds reduced free disk below the required 25 GiB floor. Real-device smoke, OAuth return, microphone, authenticated Runner streaming, and iOS compilation remain external verification gates.

Packaged build verified on 2026-10-08: the standalone frontend build at `12f169fe8fe81c7d7ede5a94c48b1752413a8e1d`, built with `REACT_APP_NATIVE_APP=true`, was copied into both native projects with `cap sync`. Android `:app:assembleDebug :app:testDebugUnitTest` passed. The resulting 97,774,486-byte APK contains the compiled frontend scripts and exact frontend provenance; its embedded Capacitor configuration has no remote `server.url`. SHA-256: `1de12e56c0557436ebe27bf183193e4d22bbee82dc8f0d33a478827b02e9a6a3`. Package `com.singulancelabs.mobile` targets API36/min24 and requests Internet, microphone and network state, without broad storage permission. This is a debug build for verification, not a signed store submission or authenticated device test. Generated frontend bundles remain outside source commits.

Final compilation refresh on 2026-10-08 packages frontend `49ac21c2d5312108ecd05ec3a04f6ff9a4039a69`, superseding the earlier `12f169fe` compilation artifact. Android debug APK and unsigned preparation AAB both build successfully with native source `490a1b499d65dc231e711560d8a0fd9621b56f17` (Capacitor8.5.3, Java21, Gradle8.14.3, API36/min24). APK: 97,939,652 bytes, SHA-256 `bbbbf46c91c340095f74864514f569f8fa06c4242ccf1f5ef35a8dd774e30906`. Unsigned AAB: 95,535,023 bytes, SHA-256 `c124e962db43e3db354fd52e079ba7e687b976a474e22f2fb458c92b2ae4c319`. ZIP inspection confirms exact provenance, compiled scripts and no remote `server.url`; the unsigned AAB excludes the debug smoke page and signature entries. Debug APK signature verification passes. These artifacts and machine-readable evidence are retained in `/root/releases/mobile-store-native-artifacts/`. No authenticated runtime/device or store-readiness result is inferred from compilation. The release gate now additionally requires real evidence for attachments, private artifact previews, approval answers, reconnect recovery, long history paging and credential isolation, all false in the example.
