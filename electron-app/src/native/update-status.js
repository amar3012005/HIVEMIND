'use strict';
// Holds the latest auto-update status so a renderer that subscribes late can read it
// (window.electron.getUpdateStatus) instead of waiting for the next change.

function createUpdateStatus({ send }) {
  let last = { status: 'idle' };
  return {
    /** Records and broadcasts a status; `payload` fields (version, percent, message) are kept with it. */
    set(status, payload = {}) { last = { status, ...payload }; send(last); return last; },
    get() { return last; },
    /** The bare state name, for logic that only needs idle|checking|downloading|downloaded|none|error. */
    state() { return last.status; },
  };
}

module.exports = { createUpdateStatus };
