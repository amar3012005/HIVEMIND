const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('offlineHistory', {
  list: () => ipcRenderer.invoke('offline-history:list'),
  read: id => ipcRenderer.invoke('offline-history:read', id),
  clear: () => ipcRenderer.invoke('offline-history:clear'),
  reconnect: () => ipcRenderer.invoke('offline-history:reconnect'),
});
