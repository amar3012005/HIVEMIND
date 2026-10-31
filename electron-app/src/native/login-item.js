'use strict';
// Open-at-login toggle (macOS login items). Starts hidden so login does not steal focus.
function createLoginItem({ app }) {
  return {
    get: () => ({ enabled: !!app.getLoginItemSettings().openAtLogin }),
    set(enabled) {
      if (typeof enabled !== 'boolean') throw new Error('enabled');
      app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: enabled });
      return { enabled: !!app.getLoginItemSettings().openAtLogin };
    },
  };
}
module.exports = { createLoginItem };
