# SINGULANCE mobile app

Capacitor 8 native projects: Android (API 36, minimum 24) and iOS (minimum 15,
Swift Package Manager). The app shell retains existing server authorization;
creating the native package does not grant account, organization, or tool access.

## Development

Use Node 22+, JDK 21 and Android SDK 36. On macOS use Xcode 26+ for iOS.

```sh
npm ci
npm run check
npm test
npm run icons
npm run sync
npm run android:debug
```

The default config serves **packaged frontend assets**. The checked-in `www/index.html`
is a deliberate development placeholder, not a usable store release. Package a
reviewed native frontend build configured for absolute API origins and native
OAuth return handling:

```sh
SINGULANCE_FRONTEND_SHA=<exact-40-character-frontend-sha> npm run package:web -- /absolute/path/to/frontend/build
npm run sync
```

Only for development, remote loading can be enabled explicitly:

```sh
SINGULANCE_MOBILE_REMOTE_URL=https://next.singulancelabs.com/hivemind/m/chat npm run sync
```

Remove this environment variable and sync again before any release. Capacitor's
[configuration documentation](https://capacitorjs.com/docs/config) identifies
`server.url` as a development feature, not a production deployment strategy.
Remote mode is not a substitute for passing store packaging/authentication checks.

## Native behavior

- Capacitor App, Browser, Keyboard and Network are registered on both platforms.
- Android allows only its exact application origin to remain in the privileged
  WebView. Other HTTPS destinations use the system browser; arbitrary schemes,
  cleartext navigation and embedded OAuth are blocked.
- Microphone access is declared for user-initiated calls; permission is requested
  by the existing runtime when the user chooses voice, not on launch.
- Android backups and cleartext traffic are disabled. Native production WebView
  debugging is disabled; Capacitor logs are limited to debug builds.
- Keyboard resizing uses the native viewport. Frontend layouts must consume
  Capacitor's safe-area CSS variables without subtracting keyboard height twice.
- `singulance://auth/callback` is the only Android custom return URI registered.
  iOS registers the scheme; the frontend must validate the exact host/path and
  complete server-validated OAuth state/PKCE. A URL is not an authentication token.
- Universal/app links are **not claimed verified**: Apple association files,
  Android asset links and real signing identities must be added together after
  account ownership is available.
- Launcher assets are rendered from the existing SINGULANCE SVG. Review the
  generated icon on devices; launcher and splash appearance still need device review.

## Release gates

`npm run android:release` fails until the compiled frontend, exact SHA, packaged
native config, signing environment and `release-evidence.json` exist. Copy
`release-evidence.example.json`, and mark a check verified only after recording
real evidence. The checks cover authentication, microphone, OAuth return,
account deletion, privacy and billing. This records required proofs; it cannot
replace physical device testing or store review.

Android signing variables (never commit their values):

- `SINGULANCE_ANDROID_KEYSTORE`
- `SINGULANCE_ANDROID_KEYSTORE_PASSWORD`
- `SINGULANCE_ANDROID_KEY_ALIAS`
- `SINGULANCE_ANDROID_KEY_PASSWORD`
- `SINGULANCE_ANDROID_VERSION_CODE` (must increase for Play uploads)
- `SINGULANCE_MOBILE_VERSION`

`npm run ios:archive` requires macOS, Xcode and `SINGULANCE_APPLE_TEAM_ID` with a
real signing identity installed. Archive export, App Store Connect registration,
privacy declarations and review submission remain account-owner steps.

## Verification on this Linux builder (8 October 2026)

- Capacitor sync: both platform projects and four plugins registered.
- TypeScript config compilation and native static checks passed.
- Android `assembleDebug testDebugUnitTest lintDebug`: passed with JDK 21,
  SDK 36 and the default local placeholder. This proves the **shell** compiles,
  not that packaged authenticated UI works.
- Navigation policy unit tests reject deceptive hosts, userinfo, HTTP, mismatched
  ports, file/JavaScript/intent URLs and custom callbacks as WebView navigation.
- Runtime dependency npm audit: zero advisories after upgrading Capacitor 8.5.3.
  The CLI-only xcode/uuid advisory is also resolved using a scoped uuid 11.1.1
  override; Capacitor iOS sync, Xcode project parsing and UUID generation passed.
  Full dependency audit is now clear.
- iOS Swift sources/project and purpose strings were generated and inspected.
  iOS compilation/signing and real device permission/OAuth behavior are unverified
  because this builder runs Linux.

Store listings, privacy/data safety answers, supported payment model, reviewer
account, screenshots and developer enrollment must be completed with actual
account and business details. Do not describe this shell as ready for public
submission until those gates and device checks pass.
