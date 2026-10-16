const { contextBridge, ipcRenderer } = require('electron');

if (process.platform === 'darwin') {
  window.addEventListener('message', async event => {
    const input = event.data;
    if (event.origin !== 'https://dots.singulancelabs.com' || input?.version !== 1) return;
    const employeeId = window.location.pathname.match(/^\/hivemind\/app\/employee\/dots\/employee\/([0-9a-f-]{36})(?:\/|$)/i)?.[1];
    if (!employeeId || input.employeeId !== employeeId) return;
    const frames = [...document.querySelectorAll('iframe[title="Open Dot workspace"],iframe[title="HIVEMIND workspace"]')].filter(frame => {
      try { return new URL(frame.src).origin === event.origin; } catch { return false; }
    });
    if (frames.length !== 1 || event.source !== frames[0].contentWindow) return;
    frames[0].title = 'HIVEMIND workspace';
    if (input.type === 'hivemind.open-dot.room-status') {
      if (typeof input.scopeKey !== 'string' || !/^[a-f0-9]{64}$/.test(input.scopeKey) || !Array.isArray(input.employees) || input.employees.length > 64) return;
      ipcRenderer.send('desktop-attention:snapshot', { version: 1, employeeId, scopeKey: input.scopeKey,
        observedAt: input.observedAt, employees: input.employees });
      const requested = new URLSearchParams(window.location.search).get('c');
      if (requested && /^conv_[A-Za-z0-9_-]+$/.test(requested) && Array.isArray(input.rooms) && input.rooms.some(room => room.conversationId === requested)) {
        const target = new URL(frames[0].src);
        if (target.searchParams.get('c') !== requested) { target.searchParams.set('c', requested); frames[0].src = target.href; }
      }
      return;
    }
    if (input.type !== 'hivemind.open-dot.desktop-browser' || !/^[0-9a-f-]{36}$/i.test(input.nonce || '') || !['detect', 'pair', 'proof'].includes(input.action)) return;
    const source = event.source;
    if (input.action === 'detect' && ['https://next.singulancelabs.com', 'https://singulancelabs.com', 'https://www.singulancelabs.com'].includes(window.location.origin)) {
      source.postMessage({ type: 'hivemind.open-dot.desktop-browser-result', version: 1, nonce: input.nonce, desktop: true }, event.origin);
      return;
    }
    let result;
    try {
      result = await ipcRenderer.invoke('desktop-browser:request', { version: 1, nonce: input.nonce, action: input.action,
        dotId: input.dotId, employeeId, ...(input.action === 'pair' ? { ticket: input.ticket } : {}),
        ...(input.action === 'proof' ? { admissionRequestId: input.admissionRequestId } : {}) });
    } catch { result = { desktop: true, ok: false, error: 'Local browser connection is unavailable. Reconnect in SINGULANCE.' }; }
    if (frames[0].isConnected && frames[0].contentWindow === source) source.postMessage({
      ...result, type: 'hivemind.open-dot.desktop-browser-result', version: 1, nonce: input.nonce,
    }, event.origin);
  });
}

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
  retryConnect: () => ipcRenderer.invoke('retry-connect'),
  // Deep-link (singulance://) — OAuth callback delivery.
  onDeepLink: (cb) => {
    const h = (_e, url) => cb(url);
    ipcRenderer.on('deep-link', h);
    return () => ipcRenderer.removeListener('deep-link', h);
  },
});
