import type { CapacitorConfig } from '@capacitor/cli';

// Store builds package the approved frontend. Remote loading is opt-in development only.
const remoteUrl = process.env.SINGULANCE_MOBILE_REMOTE_URL;
if (remoteUrl && remoteUrl !== 'https://next.singulancelabs.com/hivemind/m/chat') {
  throw new Error('Remote development URL must be the configured HTTPS mobile application.');
}
const config: CapacitorConfig = {
  appId: 'com.singulancelabs.mobile',
  appName: 'SINGULANCE',
  webDir: 'www',
  loggingBehavior: 'debug',
  backgroundColor: '#faf9f6',
  server: {
    ...(remoteUrl ? { url: remoteUrl } : {}),
    androidScheme: 'https',
    cleartext: false,
    errorPath: 'offline.html',
  },
  android: { allowMixedContent: false, webContentsDebuggingEnabled: false, minWebViewVersion: 90 },
  ios: { contentInset: 'never' },
  plugins: {
    Keyboard: { resize: 'native', resizeOnFullScreen: true },
    SystemBars: { insetsHandling: 'css' },
  },
};
export default config;
