'use strict';
// Preload of the employee room view only. Gives the room page the same close hook it has on iOS:
// window.webkit.messageHandlers.hivemindRoom.postMessage({type:"hivemind.open-dot.back", version:1}).
// Sandboxed preloads cannot require local files, so the host list is literal here; test/room-back.test.js
// keeps it equal to native/policy.js ROOM_HOSTS. The main process validates the sender again.
const { contextBridge, ipcRenderer } = require('electron');

const ROOM_HOSTS = ['runtime-runner.singulancelabs.com', 'dots.singulancelabs.com'];

const isTopFrame = () => { try { return window.top === window; } catch { return false; } };
const isRoomHost = () => location.protocol === 'https:' && ROOM_HOSTS.includes(location.hostname);

if (isTopFrame() && isRoomHost()) {
  contextBridge.exposeInMainWorld('webkit', {
    messageHandlers: {
      hivemindRoom: {
        postMessage: (msg) => {
          if (msg && typeof msg === 'object' && msg.type === 'hivemind.open-dot.back' && msg.version === 1) {
            ipcRenderer.send('native:room:back', { type: 'hivemind.open-dot.back', version: 1 });
          }
        },
      },
    },
  });
}

// Two-finger swipe right on the trackpad (a run of leftward wheel deltas) goes back, as the left-edge swipe does on iOS.
// Ignored while the touched content can scroll sideways, so wide tables and code blocks keep their own scrolling.
if (isTopFrame() && isRoomHost()) {
  const THRESHOLD = 240;     // accumulated horizontal delta in px
  const GESTURE_GAP_MS = 180; // a pause this long ends the gesture
  let total = 0; let last = 0; let fired = false;
  const scrollsSideways = (node) => {
    for (let el = node; el && el.nodeType === 1; el = el.parentElement) {
      const overflow = getComputedStyle(el).overflowX;
      if ((overflow === 'auto' || overflow === 'scroll') && el.scrollWidth > el.clientWidth) return true;
    }
    return false;
  };
  window.addEventListener('wheel', (event) => {
    const now = Date.now();
    if (now - last > GESTURE_GAP_MS) { total = 0; fired = false; }
    last = now;
    if (fired || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) { if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) total = 0; return; }
    if (event.deltaX >= 0) { total = 0; return; }
    if (scrollsSideways(event.target)) { total = 0; return; }
    total += -event.deltaX;
    if (total >= THRESHOLD) {
      fired = true;
      ipcRenderer.send('native:room:back', { type: 'hivemind.open-dot.back', version: 1 });
    }
  }, { passive: true });
}
