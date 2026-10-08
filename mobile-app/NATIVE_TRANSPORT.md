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
