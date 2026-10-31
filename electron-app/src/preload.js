const { contextBridge, ipcRenderer } = require('electron');

// Expose safe APIs to renderer (React app)
contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  isElectron: true,
  versions: {
    app: process.env.npm_package_version,
    electron: process.versions.electron,
    node: process.versions.node,
  },
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  // Auto-update: subscribe to status/progress. Returns an unsubscribe fn.
  onUpdateStatus: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('update-status', h);
    return () => ipcRenderer.removeListener('update-status', h);
  },
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  retryConnect: () => ipcRenderer.invoke('retry-connect'),
  // Deep-link (singulance://) — OAuth callback delivery.
  onDeepLink: (cb) => {
    const h = (_e, url) => cb(url);
    ipcRenderer.on('deep-link', h);
    return () => ipcRenderer.removeListener('deep-link', h);
  },
});

// PlatformAdapter for the shared sync core (tokenStore, prefs, openRoom, workspaceAccess,
// onForeground, notify). Sandboxed preloads cannot require local files, so the channel
// names are literal here; test/preload-bridge.test.js checks them against native/bridge.js.
const call = (channel, args) => ipcRenderer.invoke(channel, args);
const subscribe = (channel, cb) => {
  const h = (_e, data) => cb(data);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};
contextBridge.exposeInMainWorld('singulanceDesktop', Object.freeze({
  version: 1,
  platform: process.platform,
  tokenStore: Object.freeze({
    get: (key) => call('native:token:get', { key }).then((r) => r.value),
    set: (key, value) => call('native:token:set', { key, value }),
    remove: (key) => call('native:token:remove', { key }),
  }),
  prefs: Object.freeze({
    get: (key) => call('native:prefs:get', { key }).then((r) => r.value),
    set: (key, value) => call('native:prefs:set', { key, value }),
  }),
  request: (options) => call('native:request', options),
  workspaceAccess: () => call('native:workspace-access'),
  openRoom: (options) => call('native:room:open', options),
  prewarmRoom: (options) => call('native:room:prewarm', options),
  closeRoom: (options) => call('native:room:close', options),
  onRoomClosed: (cb) => subscribe('native:room-closed', () => cb()),
  onForeground: (cb) => subscribe('native:foreground', () => cb()),
  notify: (n) => call('native:notify', n),
  setUnread: (count) => call('native:unread', { count }),
  onNotificationClick: (cb) => subscribe('native:notification-click', cb),
  onNotificationAction: (cb) => subscribe('native:notification-action', cb),
  setNotificationPrefs: (prefs) => call('native:notify-prefs', prefs),
  setTrayStatus: (status) => call('native:tray-status', status),
  getLoginItem: () => call('native:login-item:get'),
  setLoginItem: (enabled) => call('native:login-item:set', { enabled }),
  haptic: () => {}, // Macs have no app haptic engine; kept so the API matches iOS.
}));
