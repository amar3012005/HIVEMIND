const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Narrow, explicit surface — the panel can do these six things and nothing else.
contextBridge.exposeInMainWorld('notch', {
  setExpanded: (v) => ipcRenderer.invoke('notch:set-expanded', !!v),
  capture: (text) => ipcRenderer.invoke('notch:capture', { text }),
  upload: (paths, targetScope, ingestMode) => ipcRenderer.invoke('notch:upload', { paths, targetScope, ingestMode }),
  jobStatus: (jobId) => ipcRenderer.invoke('notch:job-status', { jobId }),
  open: (route) => ipcRenderer.invoke('notch:open', { route }),
  // Electron 32+ removed File.path; webUtils is the supported way to turn a
  // dropped File into a real filesystem path.
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return file && file.path ? file.path : null; }
  },
});
