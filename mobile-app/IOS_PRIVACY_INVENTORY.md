# iOS privacy preparation inventory

Reviewed source: Capacitor iOS 8.5.3; App 8.1.1, Browser 8.0.4, Keyboard 8.0.6, Network 8.0.1; custom `SingulanceNativePlugin.swift`.

The custom bridge stores the dedicated mobile credential with Keychain Services, makes authenticated URLSession requests, exports a user-chosen file via a temporary protected file and UIDocumentPicker, and filters WK messages to the trusted main frame. Its FileManager operations create/remove its own temporary directory. They do not inspect file timestamps, available disk capacity, system boot time, or UserDefaults. No required-reason API category was found in that source inventory. An empty `NSPrivacyAccessedAPITypes` array is therefore included as an app resource; no reason code is invented for absent APIs.

The installed Capacitor 8.5.3 core and Cordova compatibility packages include their own `PrivacyInfo.xcprivacy` files with empty required-API arrays. The four installed plugins were scanned for UserDefaults, file timestamps, disk capacity and boot-time APIs; none were found. Confirm the resolved Swift package revision and merged archive privacy report on macOS, because source scanning cannot establish the final linked binary or SDK resource inclusion.

**This is not a declaration that the application collects no data.** Its backend handles identity, company context, conversations, uploaded files and (when used) voice. Before submission the owner must reconcile actual processing, retention, third-party processors, deletion and tracking behavior with the privacy policy, App Store privacy answers, Google Play Data safety and appropriate `NSPrivacyCollectedDataTypes`/tracking manifest declarations. Those declarations remain intentionally unfilled here rather than asserting unverified collection/tracking facts. `privacyReview` is a required release-evidence gate.

References: [Apple privacy manifests](https://developer.apple.com/documentation/bundleresources/privacy-manifest-files), [Apple required-reason APIs](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api), [Capacitor iOS configuration](https://capacitorjs.com/docs/ios/configuration).
