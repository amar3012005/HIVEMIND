'use strict';
// Wires the screens store, handler and updater into Electron sessions. Disabled with SINGULANCE_SCREENS=0.
const path = require('path');
const { ScreensStore } = require('./screens-store');
const { createScreensHandler } = require('./screens-handler');
const { createUpdater } = require('./screens-updater');

function createScreens({ electron, userDataDir, log = () => {}, enabled = process.env.SINGULANCE_SCREENS !== '0' }) {
  const { net } = electron;
  const store = new ScreensStore({ root: path.join(userDataDir, 'screens') });
  const updater = createUpdater({
    store, log,
    // Public code only: no cookies, no cache of this handler.
    fetch: (url, init) => net.fetch(url, { ...init, credentials: 'omit', bypassCustomProtocolHandlers: true }),
  });

  function install(ses) {
    if (!enabled) return false;
    const handler = createScreensHandler({
      store, log,
      passthrough: (request) => ses.fetch(request, { bypassCustomProtocolHandlers: true }),
    });
    try { ses.protocol.handle('https', handler); return true; }
    catch (err) { log('screens handler not installed', err.message); return false; }
  }

  return {
    install,
    store,
    updater,
    /** Pins the newest downloaded version; call before each main window loads. */
    activate: () => { if (enabled) log('screens active', JSON.stringify(store.activate())); },
    start: () => { if (enabled) updater.start(); },
    stop: () => updater.stop(),
    /** Sign-out: remove every stored screen and forget the active versions. */
    clear: () => { updater.stop(); store.clear(); if (enabled) updater.start(); },
  };
}

module.exports = { createScreens };
