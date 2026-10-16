const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentBrowserSetup', {
  getState: () => ipcRenderer.invoke('agent-browser:get-state'),
  onInstallProgress: (callback) => {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on('agent-browser:install-progress', handler);
    return () => ipcRenderer.removeListener('agent-browser:install-progress', handler);
  },
});
