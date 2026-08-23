/**
 * Notch HUD — a drop-down panel anchored under the MacBook notch.
 *
 * Hover (or click) the pill that sits in the notch and a glass panel drops with
 * the three things people reach for constantly: capture a thought, drop a file
 * into the knowledge base, and take AI meeting notes.
 *
 * Two design decisions worth stating, because they are what keep this robust:
 *
 * 1. NO DUPLICATED AUTH. The panel is local (file://) so it paints instantly and
 *    is fully styleable, but every API call is executed INSIDE the main window's
 *    page context via executeJavaScript. That origin is already signed in, so the
 *    session cookie and the stored X-API-Key apply exactly as they do in the web
 *    app — no CORS, no token copying, no second auth path to keep in sync. If the
 *    user is logged out, the call fails the same way the web app fails.
 *
 * 2. NO INVENTED ENDPOINTS. Uploads go to the same control-plane proxy the web
 *    client uses (POST /v1/proxy/knowledge/upload?async=true → job_id → poll
 *    /v1/proxy/knowledge/status), and captures go to core /api/ingest/source.
 *
 * Collapsed, the window is a small pill over the notch — dead screen area on a
 * notched Mac, and a floating pill just under the menu bar on Macs without one,
 * so the feature degrades sensibly rather than breaking.
 */
const { BrowserWindow, ipcMain, screen, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const log = require('electron-log');

// Matches the flared clip-path shape drawn in notch.html exactly — these
// must stay in lockstep with the two `clip-path: path(...)` boxes there.
const COLLAPSED = { width: 224, height: 66 };
const EXPANDED = { width: 640, height: 392 };

let notchWindow = null;
let expanded = false;
let collapseTimer = null;
let getMainWindow = () => null;
let appUrl = 'https://singulancelabs.com/hivemind/app/overview';

function bounds(size) {
  const display = screen.getPrimaryDisplay();
  const { x, y, width } = display.bounds;
  return {
    x: Math.round(x + (width - size.width) / 2),
    y, // flush with the physical top — this is where the notch lives
    width: size.width,
    height: size.height,
  };
}

function createNotchWindow({ mainWindowGetter, url }) {
  if (notchWindow) return notchWindow;
  if (typeof mainWindowGetter === 'function') getMainWindow = mainWindowGetter;
  if (url) appUrl = url;

  notchWindow = new BrowserWindow({
    ...bounds(COLLAPSED),
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Focusable so the capture field can actually receive typing. The window is
    // only shown/raised on interaction, so it does not steal focus at rest.
    focusable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'notch-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  notchWindow.loadFile(path.join(__dirname, 'notch.html'));
  // Above the menu bar, and present on every space including full-screen apps —
  // otherwise the HUD vanishes exactly when someone is in a meeting full-screen.
  notchWindow.setAlwaysOnTop(true, 'screen-saver');
  notchWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  notchWindow.once('ready-to-show', () => notchWindow.show());
  notchWindow.on('closed', () => { notchWindow = null; });

  // Re-anchor when displays change (external monitor plugged in, resolution change).
  screen.on('display-metrics-changed', reanchor);
  screen.on('display-added', reanchor);
  screen.on('display-removed', reanchor);

  return notchWindow;
}

function reanchor() {
  if (!notchWindow || notchWindow.isDestroyed()) return;
  notchWindow.setBounds(bounds(expanded ? EXPANDED : COLLAPSED));
}

function setExpanded(next) {
  if (!notchWindow || notchWindow.isDestroyed() || expanded === next) return;
  expanded = next;
  notchWindow.setBounds(bounds(next ? EXPANDED : COLLAPSED), false);
  if (next) notchWindow.setAlwaysOnTop(true, 'screen-saver');
}

/**
 * Run a fetch inside the authenticated main window and return parsed JSON.
 * Everything the panel does goes through here, so there is exactly one place
 * where credentials are involved and it is the session the user already has.
 */
async function pageFetch({ url, method = 'GET', json = null, formFile = null }) {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) throw new Error('Main window unavailable — open SINGULANCE first.');

  const payload = JSON.stringify({ url, method, json, formFile });
  const code = `(async () => {
    const req = ${payload};
    const headers = {};
    try {
      const k = window.localStorage.getItem('hm_api_key') || window.localStorage.getItem('apiKey');
      if (k) { headers['X-API-Key'] = k; headers['Authorization'] = 'Bearer ' + k; }
    } catch (_) {}
    let body;
    if (req.formFile) {
      const bin = atob(req.formFile.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const fd = new FormData();
      fd.append('file', new Blob([bytes], { type: req.formFile.mime || 'application/octet-stream' }), req.formFile.name);
      if (req.formFile.targetScope) fd.append('targetScope', req.formFile.targetScope);
      if (req.formFile.ingestMode) fd.append('ingestMode', req.formFile.ingestMode);
      fd.append('async', 'true');
      body = fd; // browser sets the multipart boundary
    } else if (req.json) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(req.json);
    }
    const res = await fetch(req.url, { method: req.method, headers, body, credentials: 'include' });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 400) }; }
    return { ok: res.ok, status: res.status, data };
  })()`;

  const out = await win.webContents.executeJavaScript(code, true);
  if (!out || !out.ok) {
    const msg = (out && out.data && (out.data.error || out.data.message)) || `HTTP ${out && out.status}`;
    throw new Error(String(msg));
  }
  return out.data;
}

// Origins are derived from the app URL the shell already trusts, so a staging
// build points at staging without a second config to forget to change.
const origins = () => {
  const host = new URL(appUrl).hostname.replace(/^next\./, '');
  return {
    core: `https://core.${host}`,
    control: `https://api.${host}`,
  };
};

function registerNotchIpc() {
  ipcMain.handle('notch:set-expanded', (_e, next) => {
    if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
    if (next) setExpanded(true);
    // Collapse on a short delay so a pointer crossing a gap does not slam it shut.
    else collapseTimer = setTimeout(() => setExpanded(false), 180);
    return true;
  });

  // Quick capture → a durable memory, through the canonical ingest front door.
  ipcMain.handle('notch:capture', async (_e, { text }) => {
    const body = String(text || '').trim();
    if (!body) throw new Error('Nothing to save.');
    const title = body.split('\n')[0].slice(0, 80);
    const data = await pageFetch({
      url: `${origins().core}/api/ingest/source`,
      method: 'POST',
      json: {
        content: body,
        title,
        mode: 'atomic',
        source: { type: 'api', platform: 'desktop-notch', filename: null },
      },
    });
    log.info('[notch] captured', data && (data.documentId || data.memoryId || ''));
    return { ok: true, id: (data && (data.documentId || data.memoryId)) || null };
  });

  // Knowledge-base upload — same control-plane proxy + job polling the web client
  // uses, so scope, quota and dedup behave identically to an in-app upload.
  ipcMain.handle('notch:upload', async (_e, { paths, targetScope, ingestMode }) => {
    let files = Array.isArray(paths) ? paths : [];
    if (!files.length) {
      const picked = await dialog.showOpenDialog(notchWindow, {
        title: 'Add to knowledge base',
        properties: ['openFile', 'multiSelections'],
      });
      if (picked.canceled) return { ok: false, cancelled: true };
      files = picked.filePaths;
    }
    const results = [];
    for (const file of files.slice(0, 10)) {
      try {
        const stat = fs.statSync(file);
        if (stat.size > 100 * 1024 * 1024) throw new Error('Over 100MB');
        const started = await pageFetch({
          url: `${origins().control}/v1/proxy/knowledge/upload?async=true`,
          method: 'POST',
          formFile: {
            base64: fs.readFileSync(file).toString('base64'),
            name: path.basename(file),
            mime: '',
            targetScope: targetScope || 'personal',
            ingestMode: ingestMode || 'both',
          },
        });
        results.push({ name: path.basename(file), ok: true, jobId: started && started.job_id, documentId: started && started.documentId });
      } catch (err) {
        log.warn('[notch] upload failed', file, err.message);
        results.push({ name: path.basename(file), ok: false, error: err.message });
      }
    }
    return { ok: results.some((r) => r.ok), results };
  });

  // Poll one upload job so the panel can show real progress rather than a spinner
  // that lies. Returns the raw status; the renderer decides how to render it.
  ipcMain.handle('notch:job-status', async (_e, { jobId }) => {
    if (!jobId) return null;
    return pageFetch({ url: `${origins().control}/v1/proxy/knowledge/status?job_id=${encodeURIComponent(jobId)}` });
  });

  // Meeting notes live in the product (recorder + transcription + the meeting
  // intelligence pass). The notch is a fast way IN, not a second recorder —
  // duplicating audio capture here would fork the pipeline for no gain.
  ipcMain.handle('notch:open', (_e, { route }) => {
    const win = getMainWindow();
    const target = new URL(route || '/hivemind/app/meetings', appUrl).toString();
    if (win && !win.isDestroyed()) {
      win.webContents.loadURL(target);
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } else {
      shell.openExternal(target);
    }
    setExpanded(false);
    return true;
  });
}

function destroyNotch() {
  if (notchWindow && !notchWindow.isDestroyed()) notchWindow.destroy();
  notchWindow = null;
}

module.exports = { createNotchWindow, registerNotchIpc, destroyNotch, setExpanded };
