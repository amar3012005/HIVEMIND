const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__electron', {
  launch: () => ipcRenderer.invoke('launch-app'),
});
