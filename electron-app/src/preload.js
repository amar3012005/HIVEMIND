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
    if (input.action === 'detect' && ['https://runtime-runner.singulancelabs.com', 'https://next.singulancelabs.com', 'https://singulancelabs.com', 'https://www.singulancelabs.com'].includes(window.location.origin)) {
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
  cancelBrowserSignIn: () => ipcRenderer.invoke('cancel-browser-sign-in'),
  // Deep-link (singulance://) — OAuth callback delivery.
  onDeepLink: (cb) => {
    const h = (_e, url) => cb(url);
    ipcRenderer.on('deep-link', h);
    return () => ipcRenderer.removeListener('deep-link', h);
  },
});

// Keep the update action visible in the sidebar even when the hosted UI has no
// desktop-updater component. Do not interrupt work or reload active calls.
if (window.top === window && ['next.singulancelabs.com', 'runtime-runner.singulancelabs.com'].includes(location.hostname)) {
  let state = {};
  const paint = () => {
    const visible = ['available', 'downloading', 'downloaded', 'frontend-update'].includes(state.status);
    let button = document.getElementById('singulance-desktop-update');
    if (!visible) { button?.remove(); return; }
    if (!document.body) return;
    if (!button) {
      button = document.createElement('button'); button.id = 'singulance-desktop-update'; button.type = 'button';
      button.style.cssText = 'margin:8px;padding:10px 14px;border:1px solid #ddd;border-radius:12px;background:#fff;color:#111;font:13px system-ui;z-index:2147483000;cursor:pointer';
      button.addEventListener('click', () => ipcRenderer.invoke(state.status === 'downloaded' ? 'install-update' : 'download-update'));
      const sidebar = document.querySelector('aside, [data-sidebar="sidebar"]');
      if (sidebar) sidebar.append(button);
      else { button.style.position = 'fixed'; button.style.bottom = '12px'; button.style.left = '12px'; document.body.append(button); }
    }
    const label = state.status === 'downloaded' ? 'Restart to update' : state.status === 'downloading' ? `Downloading update ${state.percent || 0}%` : state.status === 'frontend-update' ? 'Get updated desktop app' : 'Download update';
    if (button.textContent !== label) button.textContent = label;
    button.disabled = state.status === 'downloading';
  };
  ipcRenderer.on('update-status', (_event, value) => { state = value; paint(); });
  window.addEventListener('DOMContentLoaded', () => {
    ipcRenderer.invoke('get-update-status').then(value => { state = value; paint(); });
    new MutationObserver(paint).observe(document.body, {childList:true, subtree:true});
  });
}
