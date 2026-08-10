import type { CapacitorConfig } from '@capacitor/cli';

// Remote-loaded, same pattern as electron-app/src/main.js's
// mainWindow.loadURL(APP_URL) — the native shell wraps the existing
// /hivemind/m/* mobile web app, no separate bundle to keep in sync.
// OAuth connect flows must NOT run in this WebView (Google rejects
// embedded-webview OAuth outright) — those are intercepted and opened
// via @capacitor/browser instead, see src/main/.../MainActivity or the
// JS-side navigation guard once added.
const config: CapacitorConfig = {
  appId: 'com.singulancelabs.mobile',
  appName: 'SINGULANCE',
  webDir: 'www',
  server: {
    url: 'https://next.singulancelabs.com/hivemind/m/chat',
    androidScheme: 'https',
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
