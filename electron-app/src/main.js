const { app, BrowserWindow, shell, Menu, Tray, nativeImage, ipcMain, dialog } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const fs = require('fs');

const isDev = process.env.ELECTRON_IS_DEV === '1';
const FIRST_RUN_FLAG = path.join(app.getPath('userData'), '.launched');
const PROTOCOL = 'hivemind';

let mainWindow = null;
let splashWindow = null;
let tray = null;
let isQuitting = false;
let updateState = 'idle'; // idle | checking | downloading | downloaded | none | error

// ── App metadata ──────────────────────────────────────────────
app.setName('HIVEMIND');

// ── Logging (also captures updater diagnostics → ~/Library/Logs/HIVEMIND) ──
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
  const reactBuildPath = isDev
    ? null
    : path.join(__dirname, '..', 'react-build');

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'HIVEMIND',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#0a0a0f',
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
    // Prod: load bundled React build
    mainWindow.loadFile(path.join(reactBuildPath, 'index.html'));
  }

  // Show once ready (avoids white flash)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (!isDev) checkForUpdates();
  });

  // Open external links in default browser, not Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Intercept nav to external URLs — keep first-party in-app, open the rest in the browser.
  const INAPP_HOSTS = ['singulancelabs.com', 'hivemind.davinciai.eu', 'davinciai.eu'];
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const appUrl = isDev ? 'http://localhost:3000' : 'file://';
    let host = '';
    try { host = new URL(url).hostname; } catch (_) {}
    const inApp = url.startsWith(appUrl) || INAPP_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
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
  tray.setToolTip('HIVEMIND');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open HIVEMIND',
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
      label: 'Quit HIVEMIND',
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
      label: 'HIVEMIND',
      submenu: [
        { label: 'About HIVEMIND', role: 'about' },
        { type: 'separator' },
        { label: 'Check for Updates…', click: () => checkForUpdates(true) },
        { type: 'separator' },
        { label: 'Hide HIVEMIND', role: 'hide' },
        { label: 'Hide Others', role: 'hideOthers' },
        { label: 'Show All', role: 'unhide' },
        { type: 'separator' },
        {
          label: 'Quit HIVEMIND',
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
    dialog.showMessageBox(mainWindow, { type: 'info', title: 'You’re up to date', message: `HIVEMIND ${app.getVersion()} is the latest version.` });
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
    message: `HIVEMIND ${info && info.version ? info.version : ''} is ready.`,
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
  createWindow();
  createTray();
  createMenu();
  // Mark as launched so future opens skip splash
  fs.writeFileSync(FIRST_RUN_FLAG, '1');
  setTimeout(() => {
    if (splashWindow) splashWindow.close();
  }, 400);
});

app.whenReady().then(() => {
  const isFirstRun = !fs.existsSync(FIRST_RUN_FLAG);
  if (isFirstRun) {
    createSplash();
  } else {
    createWindow();
    createTray();
    createMenu();
  }
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
