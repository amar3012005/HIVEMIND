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
  installUpdate: () => ipcRenderer.invoke('install-update'),
  // Deep-link (hivemind://) — OAuth callback delivery.
  onDeepLink: (cb) => {
    const h = (_e, url) => cb(url);
    ipcRenderer.on('deep-link', h);
    return () => ipcRenderer.removeListener('deep-link', h);
  },
});
