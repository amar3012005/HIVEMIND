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
