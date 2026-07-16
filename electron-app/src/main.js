const { app, BrowserWindow, shell, Menu, Tray, nativeImage, ipcMain, dialog } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const fs = require('fs');

const isDev = process.env.ELECTRON_IS_DEV === '1';
// The desktop app is a first-class window onto the live product. file:// builds
// broke BrowserRouter + same-site cookie auth, so prod loads the real origin.
const APP_URL = process.env.SINGULANCE_APP_URL || 'https://singulancelabs.com/hivemind/app/overview';
const FIRST_RUN_FLAG = path.join(app.getPath('userData'), '.launched');
const PROTOCOL = 'singulance';

let mainWindow = null;
let splashWindow = null;
let tray = null;
let isQuitting = false;
let updateState = 'idle'; // idle | checking | downloading | downloaded | none | error

// ── App metadata ──────────────────────────────────────────────
app.setName('SINGULANCE');

// ── Logging (also captures updater diagnostics → ~/Library/Logs/SINGULANCE) ──
log.transports.file.level = 'info';
log.transports.console.level = isDev ? 'debug' : 'warn';
autoUpdater.logger = log;
autoUpdater.autoDownload = true;          // pull updates silently in the background
autoUpdater.autoInstallOnAppQuit = true;  // apply on next quit even if user clicks "Later"

// ── Custom protocol (hivemind://) — OAuth deep-link back into the app ──
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

function handleDeepLink(url) {
  if (!url || !url.startsWith(`${PROTOCOL}://`)) return;
  log.info('deep-link:', url);
  if (mainWindow) {
    mainWindow.webContents.send('deep-link', url);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

// ── Single-instance lock ──────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', (_e, argv) => {
  // Windows/Linux deliver the deep-link as an argv on the second instance.
  const deepLink = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
  if (deepLink) handleDeepLink(deepLink);
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// macOS delivers the deep-link via open-url.
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// ── Splash window ─────────────────────────────────────────────
function createSplash() {
  splashWindow = new BrowserWindow({
    width: 720,
    height: 480,
    resizable: false,
    center: true,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'splash-preload.js'),
    },
  });

  splashWindow.loadFile(path.join(__dirname, 'splash.html'));

  splashWindow.once('ready-to-show', () => splashWindow.show());

  splashWindow.on('closed', () => { splashWindow = null; });
}

// ── Window creation ───────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'SINGULANCE',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#faf9f4',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
    },
  });

  // Load app
  if (isDev) {
    // Dev: load from CRA dev server
    mainWindow.loadURL('http://localhost:3000');
    mainWindow.webContents.openDevTools();
  } else {
    // Prod: live product — sessions/cookies/OAuth behave exactly like a browser.
    mainWindow.loadURL(APP_URL);
  }

  // Offline / load-failure → local fallback page with retry (never a white void).
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
    if (!isMainFrame || isDev || code === -3 /* aborted (normal on redirects) */) return;
    log.warn('load failed', code, desc, failedUrl);
    mainWindow.loadFile(path.join(__dirname, 'offline.html'));
  });
  ipcMain.removeHandler('retry-connect');
  ipcMain.handle('retry-connect', () => { if (mainWindow) mainWindow.loadURL(APP_URL); });

  // Show once ready (avoids white flash)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (!isDev) checkForUpdates();
  });

  // ── Live frontend updates ────────────────────────────────────
  // The window shows the LIVE site, so every React deploy is already the new
  // version on reload. This watcher makes that automatic: poll the CRA
  // asset-manifest (changes on every FE build) every 10 min + on window focus,
  // and when a new build ships, prompt once to reload. The quick recorder
  // survives reloads by design, so refreshing is safe mid-session.
  if (!isDev) {
    const MANIFEST_URL = new URL('/asset-manifest.json', APP_URL).toString();
    let feBuildId = null;
    let fePromptOpen = false;
    let feLastCheck = 0;
    const checkFrontendUpdate = async () => {
      const now = Date.now();
      if (fePromptOpen || now - feLastCheck < 60_000) return; // focus-throttle
      feLastCheck = now;
      try {
        const res = await fetch(`${MANIFEST_URL}?t=${now}`, { cache: 'no-store' });
        if (!res.ok) return;
        const m = await res.json();
        const id = m && m.files && m.files['main.js'];
        if (!id) return;
        if (feBuildId === null) { feBuildId = id; return; } // baseline = build we loaded
        if (id === feBuildId) return;
        fePromptOpen = true;
        const { response } = await dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'HIVEMIND updated',
          message: 'A new version of HIVEMIND just went live.',
          detail: 'Reload to get the latest — your session and any active recording are preserved.',
          buttons: ['Reload Now', 'Later'],
          defaultId: 0,
          cancelId: 1,
        });
        fePromptOpen = false;
        if (response === 0) { feBuildId = id; mainWindow.webContents.reload(); }
        else { feBuildId = id; } // don't nag again for this same build
      } catch (_) { /* offline / transient — next tick */ }
    };
    const feTimer = setInterval(checkFrontendUpdate, 10 * 60_000);
    mainWindow.on('focus', checkFrontendUpdate);
    mainWindow.webContents.once('did-finish-load', checkFrontendUpdate); // set baseline
    mainWindow.on('closed', () => clearInterval(feTimer));
  }

  // First-party hosts that stay in the main window on top-level navigation.
  const INAPP_HOSTS = [
    'singulancelabs.com',            // product + control plane + core
    'zitadel.cloud',                 // Enterprise SSO / register (EU sovereign)
    'accounts.google.com',           // Google OAuth
    'login.microsoftonline.com',     // Microsoft OAuth (via ZITADEL IdP)
    'appleid.apple.com',             // Apple OAuth (via ZITADEL IdP)
  ];
  // Hosts allowed to open as a REAL child popup window (window.open). Connector
  // OAuth (Nango Connect UI + the provider consent screens) opens a popup that
  // must postMessage back to its opener — denying it or shoving it to the system
  // browser breaks the flow ("Auth pop-up blocked by your browser"). These share
  // the app session so cookies/tokens land correctly.
  const POPUP_HOSTS = [
    ...INAPP_HOSTS,
    'davinciai.eu',                  // central Nango Connect UI + host (:8043/:8042)
    'oauth2.googleapis.com',
    'nango.dev', 'nango.cloud',      // Nango-hosted variants
  ];
  const hostMatches = (url, list) => {
    try {
      const host = new URL(url).hostname;
      return list.some((h) => host === h || host.endsWith(`.${h}`));
    } catch { return false; }
  };
  const isInApp = (url) => hostMatches(url, INAPP_HOSTS);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // OAuth / connector popups → allow as a genuine child window (postMessage
    // to opener works, session shared). Everything else → default browser.
    if (hostMatches(url, POPUP_HOSTS)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520, height: 720, resizable: true,
          autoHideMenuBar: true,
          webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
        },
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const inApp = (isDev && url.startsWith('http://localhost:3000')) || url.startsWith('file://') || isInApp(url);
    if (!inApp) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Close → hide to dock (mac convention)
  mainWindow.on('close', (event) => {
    if (!isQuitting && process.platform === 'darwin') {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── Tray icon ─────────────────────────────────────────────────
function createTray() {
  const trayIconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
  const icon = nativeImage.createFromPath(trayIconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('SINGULANCE');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open SINGULANCE',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Check for Updates',
      click: () => checkForUpdates(true),
    },
    { type: 'separator' },
    {
      label: 'Quit SINGULANCE',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show();
    }
  });
}

// ── App menu ──────────────────────────────────────────────────
function createMenu() {
  const template = [
    {
      label: 'SINGULANCE',
      submenu: [
        { label: 'About SINGULANCE', role: 'about' },
        { type: 'separator' },
        { label: 'Check for Updates…', click: () => checkForUpdates(true) },
        { type: 'separator' },
        { label: 'Hide SINGULANCE', role: 'hide' },
        { label: 'Hide Others', role: 'hideOthers' },
        { label: 'Show All', role: 'unhide' },
        { type: 'separator' },
        {
          label: 'Quit SINGULANCE',
          accelerator: 'Cmd+Q',
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Auto-updater ──────────────────────────────────────────────
// Robust flow: silent background download (autoDownload), non-blocking renderer
// status, install-on-quit fallback. Manual checks give explicit feedback;
// background checks stay quiet unless an update is actually ready.
let manualCheck = false;

function sendUpdate(status, payload = {}) {
  updateState = status;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', { status, ...payload });
  }
}

function checkForUpdates(manual = false) {
  if (isDev) {
    if (manual) dialog.showMessageBox(mainWindow, { type: 'info', title: 'Updates', message: 'Update checks are disabled in dev.' });
    return;
  }
  if (updateState === 'downloading') {
    if (manual) dialog.showMessageBox(mainWindow, { type: 'info', title: 'Updating', message: 'An update is already downloading.' });
    return;
  }
  manualCheck = manual;
  sendUpdate('checking');
  autoUpdater.checkForUpdates().catch((err) => {
    log.error('update check failed', err);
    sendUpdate('error', { message: String(err && err.message || err) });
    if (manual) {
      dialog.showMessageBox(mainWindow, {
        type: 'warning', title: 'Update Check',
        message: 'Could not check for updates.', detail: 'Check your connection and try again.',
      });
    }
  });
}

autoUpdater.on('update-available', (info) => {
  log.info('update available', info && info.version);
  sendUpdate('downloading', { version: info && info.version });
});

autoUpdater.on('update-not-available', () => {
  sendUpdate('none');
  if (manualCheck) {
    dialog.showMessageBox(mainWindow, { type: 'info', title: 'You’re up to date', message: `SINGULANCE ${app.getVersion()} is the latest version.` });
    manualCheck = false;
  }
});

autoUpdater.on('download-progress', (p) => {
  // stream progress to the renderer (UI can show a bar); throttle dock too
  sendUpdate('downloading', { percent: Math.round(p.percent), bytesPerSecond: p.bytesPerSecond, transferred: p.transferred, total: p.total });
  if (process.platform === 'darwin' && app.dock) app.dock.setBadge(`${Math.round(p.percent)}%`);
});

autoUpdater.on('error', (err) => {
  log.error('updater error', err);
  sendUpdate('error', { message: String(err && err.message || err) });
  if (process.platform === 'darwin' && app.dock) app.dock.setBadge('');
});

autoUpdater.on('update-downloaded', (info) => {
  log.info('update downloaded', info && info.version);
  sendUpdate('downloaded', { version: info && info.version });
  if (process.platform === 'darwin' && app.dock) app.dock.setBadge('');
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Update Ready',
    message: `SINGULANCE ${info && info.version ? info.version : ''} is ready.`,
    detail: 'Restart now to apply, or it will install automatically next time you quit.',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) { isQuitting = true; autoUpdater.quitAndInstall(); }
  });
});

// ── App lifecycle ─────────────────────────────────────────────
ipcMain.handle('open-external', (_, url) => {
  shell.openExternal(url);
});

ipcMain.handle('check-for-updates', () => { checkForUpdates(true); });
ipcMain.handle('install-update', () => {
  if (updateState === 'downloaded') { isQuitting = true; autoUpdater.quitAndInstall(); }
});

// IPC: splash "launch" button → open main window, close splash
ipcMain.handle('launch-app', () => {
  if (!mainWindow) { createWindow(); createTray(); createMenu(); }
  else { mainWindow.show(); }
  // Let the splash finish its fade, then dismiss it.
  setTimeout(() => { if (splashWindow) splashWindow.close(); }, 450);
});

app.whenReady().then(() => {
  // Cinematic B&W signature intro on every open, then the workspace.
  createSplash();
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

// Keep app alive on mac even when all windows closed
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
