const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const HASH = /^[a-f0-9]{64}$/;
const TITLES = { question: 'Agent Question', approval: 'Approval Pending', completed: 'Response Ready', blocked: 'Agent Attention' };
const BODIES = { question: 'An agent is waiting for your response.', approval: 'An agent action is waiting for approval.', completed: 'An agent response is ready.', blocked: 'Agent work needs your attention.' };

function normalizeAgentSnapshot(input) {
  if (!input || input.version !== 1 || !HASH.test(input.scopeKey || '') || !Number.isSafeInteger(input.observedAt) || !Array.isArray(input.employees) || input.employees.length > 64) {
    throw new Error('Invalid agent activity snapshot');
  }
  const rooms = [];
  const identities = new Set();
  for (const employee of input.employees) {
    if (!UUID.test(employee?.employeeId || '') || !ID.test(employee.dotId || '') || !Array.isArray(employee.rooms) || employee.rooms.length > 128) throw new Error('Invalid employee activity scope');
    for (const room of employee.rooms) {
      if (!ID.test(room?.conversationId || '') || ['running', 'actionRequired', 'waitingForAnswer', 'error'].some(key => typeof room[key] !== 'boolean') || !Number.isSafeInteger(room.lastAssistantAt) || room.lastAssistantAt < 0) throw new Error('Invalid agent room activity');
      if (room.pendingCardId != null && !ID.test(room.pendingCardId) || room.lastAssistantMessageId != null && !ID.test(room.lastAssistantMessageId)) throw new Error('Invalid native work identity');
      const identity = JSON.stringify([employee.employeeId, employee.dotId, room.conversationId]);
      if (identities.has(identity) || rooms.length >= 128) throw new Error('Duplicate or oversized agent activity');
      identities.add(identity);
      rooms.push({ employeeId: employee.employeeId, dotId: employee.dotId, conversationId: room.conversationId,
        running: room.running, actionRequired: room.actionRequired, waitingForAnswer: room.waitingForAnswer, error: room.error,
        pendingCardId: room.pendingCardId ?? null, lastAssistantMessageId: room.lastAssistantMessageId ?? null,
        lastAssistantAt: room.lastAssistantAt, unread: room.unread === true });
    }
  }
  return { version: 1, scopeKey: input.scopeKey, observedAt: input.observedAt, rooms };
}
function attentionKind(room) {
  return room.waitingForAnswer ? 'question' : room.actionRequired ? 'approval' : room.error ? 'blocked' : 'completed';
}
function nativeWorkKey(scopeKey, room, kind) {
  const record = kind === 'completed' ? room.lastAssistantMessageId : room.pendingCardId;
  if (!record) return null;
  return crypto.createHash('sha256').update(JSON.stringify([scopeKey, room.employeeId, room.dotId, room.conversationId, kind, record])).digest('hex');
}
function createAgentAttention({ app, Notification, userDataPath, getMainWindow, openTarget, onState = () => {}, log = console }) {
  const settingsPath = path.join(userDataPath, 'agent-attention.json');
  let preferences = { version: 1, enabled: false, delivered: [] };
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (saved.version === 1 && typeof saved.enabled === 'boolean' && Array.isArray(saved.delivered)) preferences = { version: 1, enabled: saved.enabled, delivered: saved.delivered.filter(key => HASH.test(key)).slice(-512) };
  } catch (error) { if (error.code !== 'ENOENT') log.warn('Agent notification preferences are unavailable'); }
  let snapshot = null;
  let closed = false;
  let expiryTimer = null;
  const notifications = new Map();
  const unread = new Set();
  const delivered = new Set(preferences.delivered);
  function save() {
    fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
    const temporary = `${settingsPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, enabled: preferences.enabled, delivered: [...delivered].slice(-512) }) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, settingsPath);
  }
  function getState() {
    const rooms = snapshot?.rooms ?? [];
    return { enabled: preferences.enabled, connected: snapshot !== null,
      working: rooms.filter(room => room.running).length,
      waiting: rooms.filter(room => room.waitingForAnswer || room.actionRequired).length,
      blocked: rooms.filter(room => room.error).length,
      unread: unread.size };
  }
  function publish() {
    const state = getState();
    if (app.dock) app.dock.setBadge(state.unread ? String(state.unread) : '');
    onState(state);
  }
  function clear() {
    clearTimeout(expiryTimer); expiryTimer = null;
    for (const notification of notifications.values()) notification.close();
    notifications.clear(); unread.clear(); snapshot = null; publish();
  }
  function receive(input) {
    if (closed) return;
    const next = normalizeAgentSnapshot(input);
    const previous = snapshot;
    if (previous?.scopeKey === next.scopeKey && next.observedAt < previous.observedAt) return;
    if (previous && previous.scopeKey !== next.scopeKey) clear();
    snapshot = next;
    clearTimeout(expiryTimer); expiryTimer = setTimeout(clear, 45000); expiryTimer.unref?.();
    const eligible = new Set();
    for (const room of next.rooms) {
      const needsAttention = room.waitingForAnswer || room.actionRequired || room.error;
      if (!needsAttention && (room.running || !room.unread || !previous || previous.scopeKey !== next.scopeKey)) continue;
      const kind = attentionKind(room);
      const key = nativeWorkKey(next.scopeKey, room, kind);
      if (!key) continue;
      eligible.add(key);
      if (!preferences.enabled || delivered.has(key) || getMainWindow()?.isFocused() || !Notification.isSupported()) continue;
      const notification = new Notification({ title: TITLES[kind], body: BODIES[kind], silent: kind === 'completed' });
      notifications.set(key, notification);
      notification.on('click', () => {
        unread.delete(key); notifications.delete(key); notification.close(); publish();
        Promise.resolve(openTarget({ scopeKey: next.scopeKey, employeeId: room.employeeId, dotId: room.dotId, conversationId: room.conversationId })).catch(() => log.warn('Agent notification target is no longer available'));
      });
      delivered.add(key);
      while (delivered.size > 512) delivered.delete(delivered.values().next().value);
      unread.add(key); save(); notification.show();
    }
    for (const [key, notification] of notifications) {
      if (!eligible.has(key)) { notification.close(); notifications.delete(key); unread.delete(key); }
    }
    publish();
  }
  return {
    receive,
    getState,
    clear,
    setEnabled(enabled) {
      if (typeof enabled !== 'boolean') throw new Error('Notification preference must be explicit');
      preferences.enabled = enabled; save();
      if (!enabled) { for (const notification of notifications.values()) notification.close(); notifications.clear(); unread.clear(); }
      publish();
    },
    close() { closed = true; clear(); },
  };
}
module.exports = { normalizeAgentSnapshot, nativeWorkKey, createAgentAttention };
