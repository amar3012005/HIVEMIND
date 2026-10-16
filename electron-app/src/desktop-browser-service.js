const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createDesktopBrowserBridge } = require('./desktop-browser-bridge');
const { createInAppBrowser } = require('./in-app-browser');
const { isLocalTest } = require('./release-channel');

function createDesktopBrowserService({ app, BrowserWindow, dialog, ipcMain, session, getMainWindow, trustedOrigins, log }) {
  const userDataPath = app.getPath('userData');
  let setupWindow = null;
  let installing = false;
  let closed = false;
  let bridge = null;
  const legacyBrowser = process.mas ? null : isLocalTest ? null : require('./managed-agent-browser');
  const approval = process.mas ? null : isLocalTest ? null : legacyBrowser.startApprovalServer({ userDataPath, dialog, getParentWindow: getMainWindow, log,
    authorizeAction: ({ profileId }) => !closed && bridge ? bridge.authorizeProfile(profileId) : false });
  bridge = createDesktopBrowserBridge({ userDataPath, appPath: app.getAppPath(), appExecutable: process.execPath,
    fetchSession: (url, options) => session.defaultSession.fetch(url, options), log,
    createLocalExecutor: process.mas ? profile => createInAppBrowser({ BrowserWindow, session, dialog, profile, getMainWindow,
      authorize: () => !closed && bridge.authorizeProfile(profile.id) })
      : isLocalTest ? profile => createInAppBrowser({ BrowserWindow, session, dialog, profile, getMainWindow,
        authorize: () => !closed && bridge.authorizeProfile(profile.id) }) : undefined,
    approvalReady: async () => { if (closed) throw new Error('Local browser service is closed'); await approval.ready; } });
  approval?.ready.catch(() => log.warn('Local browser approval service is unavailable'));

  function assertSetupSender(event) {
    if (!setupWindow || setupWindow.isDestroyed() || event.sender.id !== setupWindow.webContents.id || event.senderFrame !== setupWindow.webContents.mainFrame) {
      throw new Error('Browser setup request requires its owned window');
    }
  }
  function openSetup() {
    if (closed) return;
    if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.show(); setupWindow.focus(); return; }
    const setupUrl = pathToFileURL(path.join(__dirname, 'agent-browser.html')).href;
    setupWindow = new BrowserWindow({ width: 570, height: 440, minWidth: 480, minHeight: 370,
      title: 'SINGULANCE Agent Browser', show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
        preload: path.join(__dirname, 'agent-browser-preload.js') } });
    setupWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    setupWindow.webContents.on('will-navigate', event => { if (event.url !== setupUrl) event.preventDefault(); });
    setupWindow.once('ready-to-show', () => { if (setupWindow && !setupWindow.isDestroyed()) setupWindow.show(); });
    setupWindow.on('closed', () => { setupWindow = null; });
    setupWindow.loadFile(path.join(__dirname, 'agent-browser.html'));
  }
  async function install() {
    if (closed || installing) return;
    if (process.mas || isLocalTest || legacyBrowser.isRuntimeInstalled(userDataPath)) { openSetup(); return; }
    const parent = getMainWindow();
    const options = { type: 'question', title: 'Private Agent Browser',
      message: 'Install an isolated browser for agent tasks?',
      detail: 'Chromium is downloaded into SINGULANCE’s private app storage. Personal Chrome profiles, history and passwords are not imported. Browser access and important actions still require your approval.',
      buttons: ['Install', 'Not Now'], defaultId: 1, cancelId: 1, noLink: true };
    const answer = await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
    if (answer.response !== 0 || closed) return;
    installing = true;
    openSetup();
    try {
      await legacyBrowser.installBrowserRuntime({ userDataPath, appPath: app.getAppPath(), electronExecutable: process.execPath });
      if (setupWindow && !setupWindow.isDestroyed()) setupWindow.webContents.send('agent-browser:install-progress', 'Agent browser ready');
    } catch {
      log.warn('Private browser installation failed');
      if (setupWindow && !setupWindow.isDestroyed()) setupWindow.webContents.send('agent-browser:install-progress', 'Installation failed. Retry from the SINGULANCE menu.');
    } finally { installing = false; }
  }
  ipcMain.handle('agent-browser:get-state', event => {
    assertSetupSender(event);
    return { installed: process.mas === true || isLocalTest || legacyBrowser.isRuntimeInstalled(userDataPath), bundled: process.mas === true || isLocalTest, installing };
  });
  ipcMain.handle('desktop-browser:request', (event, request) => {
    const window = getMainWindow();
    if (closed || !window || window.isDestroyed() || event.sender.id !== window.webContents.id || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Desktop browser request requires its owned main window');
    }
    const url = new URL(window.webContents.getURL());
    const employeeId = url.pathname.match(/^\/hivemind\/app\/employee\/dots\/employee\/([0-9a-f-]{36})(?:\/|$)/i)?.[1];
    if (!trustedOrigins.includes(url.origin) || !employeeId) throw new Error('Owned employee browser target is unavailable');
    return bridge.handle(request, employeeId);
  });
  return {
    openSetup,
    install,
    async reviewUnknown() {
      const window = getMainWindow();
      if (closed || !window || window.isDestroyed()) throw new Error('Open the employee browser workspace first');
      const url = new URL(window.webContents.getURL());
      const employeeId = url.pathname.match(/^\/hivemind\/app\/employee\/dots\/employee\/([0-9a-f-]{36})(?:\/|$)/i)?.[1];
      if (!trustedOrigins.includes(url.origin) || !employeeId) throw new Error('Open the employee browser workspace first');
      await bridge.reviewUnknown(employeeId, async count => {
        const answer = await dialog.showMessageBox(window, { type: 'warning', title: 'Review Paused Browser Actions',
          message: `${count} browser action${count === 1 ? ' has' : 's have'} an uncertain result.`,
          detail: 'First pause the agent and inspect its visible managed browser. Confirm only after checking whether the action happened. This clears the blocked receipt without repeating the action or resuming the agent.',
          buttons: ['I Inspected This Browser', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true });
        return answer.response === 0;
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      ipcMain.removeHandler('agent-browser:get-state');
      ipcMain.removeHandler('desktop-browser:request');
      if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close();
      await bridge.close();
      approval?.close();
    },
  };
}
module.exports = { createDesktopBrowserService };
