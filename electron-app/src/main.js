const { app, BrowserWindow, shell, Menu, Tray, nativeImage, ipcMain, dialog, session, Notification, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { isLocalTest } = require('./release-channel');
if (isLocalTest) {
  const directory = path.join(app.getPath('appData'), 'SINGULANCE Local Test');
  require('./browser-profiles').ensurePrivateDir(directory);
  app.setPath('userData', directory);
  app.setPath('sessionData', directory);
  app.setName('SINGULANCE Local Test');
}
const autoUpdater = process.mas ? null : isLocalTest ? null : require('electron-updater').autoUpdater;
const log = require('electron-log');
const notch = process.mas ? null : isLocalTest ? null : require('./notch');
const { createDesktopBrowserService } = require('./desktop-browser-service');
const { createAgentAttention, normalizeAgentSnapshot } = require('./agent-attention');
const { createOfflineHistory } = require('./offline-history');
const { installBundledFrontends } = require('./bundled-frontends');
const FRONTEND_BUNDLE = path.join(__dirname, '..', 'assets', 'frontend');
const hasBundledFrontends = fs.existsSync(path.join(FRONTEND_BUNDLE, 'manifest.json'));

const isDev = process.env.ELECTRON_IS_DEV === '1';
// The desktop app is a first-class window onto the live product. file:// builds
// broke BrowserRouter + same-site cookie auth, so prod loads the real origin.
const APP_URL = process.env.SINGULANCE_APP_URL || 'https://runtime-runner.singulancelabs.com/hivemind/app/employee/harness';
const FIRST_RUN_FLAG = path.join(app.getPath('userData'), '.launched');
const PROTOCOL = isLocalTest ? 'singulance-local-test' : 'singulance';
const APP_ORIGIN = new URL(APP_URL).origin;
const TRUSTED_APP_ORIGINS = [...new Set([APP_ORIGIN, 'https://next.singulancelabs.com', 'https://www.singulancelabs.com'])];
let desktopBrowserService = null;
let offlineHistory = null;
let agentAttention = null;

let mainWindow = null;
let splashWindow = null;
let tray = null;
let isQuitting = false;
let updateState = 'idle'; // idle | checking | downloading | downloaded | none | error

// ── App metadata ──────────────────────────────────────────────
app.setName(isLocalTest ? 'SINGULANCE Local Test' : 'SINGULANCE');

// ── Logging (also captures updater diagnostics → ~/Library/Logs/SINGULANCE) ──
log.transports.file.level = 'info';
log.transports.console.level = isDev ? 'debug' : 'warn';
if (autoUpdater) {
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
}

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
    title: app.getName(),
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

  offlineHistory?.attach(mainWindow);

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
    if (!isMainFrame && code !== -3) { try { log.warn('Employee frame load failed', { code, desc, origin: new URL(failedUrl).origin, path: new URL(failedUrl).pathname }); } catch {} }
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
  if (!isDev && !hasBundledFrontends) {
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

  mainWindow.webContents.on('will-navigate', event => {
    const url = event.url;
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

function ownedEmployeeSender(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('Agent activity requires the owned main window');
  }
  const url = new URL(mainWindow.webContents.getURL());
  const employeeId = url.pathname.match(/^\/hivemind\/app\/employee\/dots\/employee\/([0-9a-f-]{36})(?:\/|$)/i)?.[1];
  if (!TRUSTED_APP_ORIGINS.includes(url.origin) || !employeeId) throw new Error('Agent activity requires its canonical employee workspace');
  return employeeId;
}
async function openAgentTarget(target) {
  const response = await session.defaultSession.fetch('https://dots.singulancelabs.com/api/hivemind/employees/status', {
    credentials: 'include', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Agent target authorization is unavailable');
  const current = normalizeAgentSnapshot(await response.json());
  if (current.scopeKey !== target.scopeKey || !current.rooms.some(room => room.employeeId === target.employeeId && room.dotId === target.dotId && room.conversationId === target.conversationId)) {
    throw new Error('Agent notification no longer belongs to the current account');
  }
  const url = new URL(`/hivemind/app/employee/dots/employee/${target.employeeId}`, APP_URL);
  url.searchParams.set('c', target.conversationId);
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); createTray(); }
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  await mainWindow.loadURL(url.href);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
}
async function configureAgentNotifications() {
  if (!agentAttention) return;
  const enabled = agentAttention.getState().enabled;
  const answer = await dialog.showMessageBox(mainWindow, { type: 'question', title: 'Agent Notifications',
    message: enabled ? 'Turn off native agent notifications?' : 'Receive native notifications when agent work needs your attention?',
    detail: 'Notifications contain generic status only, not messages, passwords or tool arguments. macOS notification and Focus settings remain in control. Clicking a notification opens existing work; it never approves an action.',
    buttons: [enabled ? 'Turn Off' : 'Enable Notifications', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true });
  if (answer.response === 0) agentAttention.setEnabled(!enabled);
}
function showAgentActivity() {
  const state = agentAttention?.getState();
  const detail = !state?.connected ? 'Open an authenticated HIVEMIND employee workspace to receive owned agent activity.'
    : `Working: ${state.working}\nWaiting for your input or approval: ${state.waiting}\nNeeds attention: ${state.blocked}\nUnread native notifications: ${state.unread}`;
  dialog.showMessageBox(mainWindow, { type: 'info', title: 'Agent Activity', message: 'Your existing agent work', detail, buttons: ['OK'] });
}

// ── App menu ──────────────────────────────────────────────────
function createMenu() {
  const template = [
    {
      label: app.getName(),
      submenu: [
        { label: 'About SINGULANCE', role: 'about' },
        { type: 'separator' },
        { label: 'Check for Updates…', click: () => checkForUpdates(true) },
        ...(process.platform === 'darwin' ? [
          { label: 'Agent Browser…', click: () => desktopBrowserService?.install() },
          { label: 'Review Paused Browser Actions…', click: () => desktopBrowserService?.reviewUnknown().catch(error => dialog.showMessageBox(mainWindow, {
            type: 'info', title: 'Browser Review', message: String(error.message), buttons: ['OK'],
          })) },
          { label: 'Agent Activity…', click: showAgentActivity },
          { label: agentAttention?.getState().enabled ? 'Agent Notifications: On…' : 'Agent Notifications: Off…', click: configureAgentNotifications },
        ] : []),
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
        { label: 'Saved Conversations (Offline)…', accelerator: 'CmdOrCtrl+Shift+H', click: () => offlineHistory?.show() },
        { type: 'separator' },
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
  if (isLocalTest) {
    if (manual) dialog.showMessageBox(mainWindow, { type: 'info', title: 'Local Test Build', message: 'This isolated local build does not download or install updates.' });
    return;
  }
  if (process.mas) {
    if (manual) dialog.showMessageBox(mainWindow, { type: 'info', title: 'App Updates', message: 'Updates are delivered through TestFlight or the Mac App Store.' });
    return;
  }
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

if (autoUpdater) {
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
  sendUpdate('downloading', { percent: Math.round(p.percent), bytesPerSecond: p.bytesPerSecond, transferred: p.transferred, total: p.total });
});

autoUpdater.on('error', (err) => {
  log.error('updater error', err);
  sendUpdate('error', { message: String(err && err.message || err) });
  if (agentAttention && app.dock) { const unread = agentAttention.getState().unread; app.dock.setBadge(unread ? String(unread) : ''); }
});

autoUpdater.on('update-downloaded', (info) => {
  log.info('update downloaded', info && info.version);
  sendUpdate('downloaded', { version: info && info.version });
  if (agentAttention && app.dock) { const unread = agentAttention.getState().unread; app.dock.setBadge(unread ? String(unread) : ''); }
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
}

// ── App lifecycle ─────────────────────────────────────────────
ipcMain.on('desktop-attention:snapshot', (event, input) => {
  try {
    if (!agentAttention || isQuitting || input?.employeeId !== ownedEmployeeSender(event)) return;
    agentAttention.receive(input);
  } catch { log.warn('Rejected unowned or invalid agent activity'); }
});
ipcMain.handle('open-external', (_, url) => {
  shell.openExternal(url);
});

ipcMain.handle('check-for-updates', () => { checkForUpdates(true); });
ipcMain.handle('install-update', () => {
  if (autoUpdater && updateState === 'downloaded') { isQuitting = true; autoUpdater.quitAndInstall(); }
});

// IPC: splash "launch" button → open main window, close splash
ipcMain.handle('launch-app', () => {
  if (!mainWindow) { createWindow(); createTray(); createMenu(); }
  else { mainWindow.show(); }
  // Let the splash finish its fade, then dismiss it.
  setTimeout(() => { if (splashWindow) splashWindow.close(); }, 450);
});

app.whenReady().then(() => {
  offlineHistory = createOfflineHistory({ app, safeStorage, BrowserWindow, ipcMain, getMainWindow: () => mainWindow, log });
  if (!isDev && hasBundledFrontends) installBundledFrontends(session.defaultSession, FRONTEND_BUNDLE, log, offlineHistory);
  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(path.join(__dirname, '..', 'assets', 'icon.png'));
  if (process.platform === 'darwin') {
    desktopBrowserService = createDesktopBrowserService({ app, BrowserWindow, dialog, ipcMain, session,
      getMainWindow: () => mainWindow, trustedOrigins: TRUSTED_APP_ORIGINS, log });
    agentAttention = createAgentAttention({ app, Notification, userDataPath: app.getPath('userData'),
      getMainWindow: () => mainWindow, openTarget: openAgentTarget, log,
      onState: state => {
        if (isQuitting) return;
        if (tray) tray.setToolTip(`SINGULANCE — ${state.working} working, ${state.waiting} waiting, ${state.blocked} need attention`);
        createMenu();
      } });
  }
  // Cinematic B&W signature intro on every open, then the workspace.
  createSplash();

  // Notch HUD — quick capture, knowledge-base drops and meeting notes, hanging
  // off the top edge. It resolves the main window lazily (that is where its API
  // calls execute, using the session already signed in), so it can come up here
  // without waiting for the splash → workspace handoff. Never fatal: a HUD
  // failure must not stop the app from opening.
  //
  // DEFAULT OFF as of 2.1.1. The panel has never been exercised at runtime — it
  // could not be launched locally while macOS was deleting the unsigned Electron
  // binary — and an always-on-top window pinned over the menu bar is the wrong
  // thing to ship unverified: a bad geometry or a stuck pill is highly visible
  // and hard for a user to escape. The code stays in the bundle so re-enabling
  // is a flag flip, not a rebuild of the feature.
  //
  //   Enable for a session:  SINGULANCE_NOTCH=1 open -a SINGULANCE
  //   Enable in dev:         SINGULANCE_NOTCH=1 npm start
  if (!process.mas && !isLocalTest && process.env.SINGULANCE_NOTCH === '1') {
    try {
      notch.registerNotchIpc();
      notch.createNotchWindow({ mainWindowGetter: () => mainWindow, url: APP_URL });
      log.info('[notch] enabled via SINGULANCE_NOTCH=1');
    } catch (err) {
      log.warn('[notch] failed to mount:', err.message);
    }
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
  if (agentAttention) agentAttention.close();
  if (desktopBrowserService) void desktopBrowserService.close().catch(() => log.warn('Desktop browser shutdown did not finish'));
  // The HUD is alwaysOnTop + visible on all workspaces; if it outlives the app
  // it leaves a black pill stuck over the menu bar until logout.
  try { notch?.destroyNotch(); } catch (_) { /* already gone */ }
});

// Keep app alive on mac even when all windows closed
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
