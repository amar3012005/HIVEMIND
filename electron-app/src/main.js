const { app, BrowserWindow, shell, Menu, Tray, nativeImage, ipcMain, dialog } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const fs = require('fs');

const isDev = process.env.ELECTRON_IS_DEV === '1';
const FIRST_RUN_FLAG = path.join(app.getPath('userData'), '.launched');

let mainWindow = null;
let splashWindow = null;
let tray = null;
let isQuitting = false;

// ── App metadata ──────────────────────────────────────────────
app.setName('HIVEMIND');

// ── Single-instance lock ──────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
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

  // Intercept nav to external URLs — keep in-app
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const appUrl = isDev ? 'http://localhost:3000' : 'file://';
    const isHivemind = url.startsWith(appUrl) || url.includes('hivemind.davinciai.eu');
    if (!isHivemind) {
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
function checkForUpdates(manual = false) {
  autoUpdater.checkForUpdatesAndNotify().catch(() => {
    if (manual) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Check',
        message: 'Could not check for updates. Check your connection.',
      });
    }
  });
}

autoUpdater.on('update-available', () => {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Update Available',
    message: 'A new version of HIVEMIND is downloading in the background.',
  });
});

autoUpdater.on('update-downloaded', () => {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Update Ready',
    message: 'A new version has been downloaded. Restart HIVEMIND to apply.',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
  }).then(({ response }) => {
    if (response === 0) {
      isQuitting = true;
      autoUpdater.quitAndInstall();
    }
  });
});

// ── App lifecycle ─────────────────────────────────────────────
ipcMain.handle('open-external', (_, url) => {
  shell.openExternal(url);
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
