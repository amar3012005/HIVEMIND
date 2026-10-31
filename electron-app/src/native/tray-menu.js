'use strict';
// Pure menu-bar (Tray) menu construction from renderer-pushed status; Electron objects stay in main.js.
const MAX_WORKING = 5;

function clip(s, n) { const t = String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; }

/** Validates {needsYou, working:[{name, step}]}; unknown shapes collapse to empty. Keeps at most 5 employees. */
function normalizeStatus(s) {
  const needsYou = s && Number.isInteger(s.needsYou) && s.needsYou >= 0 ? Math.min(s.needsYou, 999) : 0;
  const working = [];
  if (s && Array.isArray(s.working)) {
    for (const w of s.working) {
      if (working.length >= MAX_WORKING) break;
      if (w && typeof w.name === 'string' && w.name.trim()) working.push({ name: clip(w.name, 40), step: clip(w.step, 60) });
    }
  }
  return { needsYou, working };
}

function buildTrayTemplate(status, { openAtLogin = false, onOpen, onToggleLogin, onCheckUpdates, onQuit }) {
  const t = [
    { label: status.needsYou ? `Needs you: ${status.needsYou}` : 'Nothing needs you', enabled: false },
    { type: 'separator' },
  ];
  if (status.working.length) {
    t.push({ label: 'Working now', enabled: false });
    for (const w of status.working) t.push({ label: w.step ? `${w.name}: ${w.step}` : w.name, enabled: false });
  } else {
    t.push({ label: 'No one is working right now', enabled: false });
  }
  t.push(
    { type: 'separator' },
    { label: 'Open SINGULANCE', click: onOpen },
    { label: 'Open at login', type: 'checkbox', checked: !!openAtLogin, click: onToggleLogin },
  );
  if (onCheckUpdates) t.push({ label: 'Check for Updates', click: onCheckUpdates });
  t.push({ type: 'separator' }, { label: 'Quit SINGULANCE', click: onQuit });
  return t;
}

module.exports = { MAX_WORKING, normalizeStatus, buildTrayTemplate };
