const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createAgentAttention, normalizeAgentSnapshot } = require('../src/agent-attention');

const employeeId = '12345678-1234-4234-8234-123456789abc';
const scopeKey = 'a'.repeat(64);
function packet(overrides = {}) {
  return { version: 1, scopeKey, observedAt: Date.now(), employees: [{ employeeId, dotId: 'dot_fixture', rooms: [{
    conversationId: 'conv_fixture', running: false, actionRequired: false, waitingForAnswer: true, error: false,
    pendingCardId: 'card_fixture', lastAssistantMessageId: null, lastAssistantAt: 0, ...overrides,
  }] }] };
}
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'singulance-attention-test-'));
  const shown = []; const opened = []; const badges = [];
  let focused = false;
  class FakeNotification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; }
    show() { shown.push(this); }
    close() { this.closed = true; }
  }
  const input = { app: { dock: { setBadge: value => badges.push(value) } }, Notification: FakeNotification,
    userDataPath: directory, getMainWindow: () => ({ isFocused: () => focused }), openTarget: target => { opened.push(target); } };
  return { directory, shown, opened, badges, input, create: () => createAgentAttention(input),
    focus: value => { focused = value; }, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test('notifications require explicit opt-in and exclude private source content', () => {
  const f = fixture(); const service = f.create();
  try {
    const input = packet(); input.employees[0].rooms[0].text = 'private-tool-arguments';
    service.receive(input); assert.equal(f.shown.length, 0);
    service.setEnabled(true); service.receive(input);
    assert.equal(f.shown.length, 1);
    assert.doesNotMatch(JSON.stringify(f.shown[0].options), /private-tool-arguments|card_fixture|conv_fixture/);
    assert.equal(service.getState().waiting, 1);
  } finally { service.close(); f.cleanup(); }
});
test('native record identity deduplicates delivery across reconnect and restart', () => {
  const f = fixture(); let service = f.create();
  try {
    service.setEnabled(true); service.receive(packet()); service.receive(packet());
    assert.equal(f.shown.length, 1); service.close();
    service = f.create(); service.receive(packet()); assert.equal(f.shown.length, 1);
    service.receive(packet({ pendingCardId: 'card_second' })); assert.equal(f.shown.length, 2);
  } finally { service.close(); f.cleanup(); }
});
test('notification click targets existing owned work without approving it', async () => {
  const f = fixture(); const service = f.create();
  try {
    service.setEnabled(true); service.receive(packet()); f.shown[0].emit('click');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.opened, [{ scopeKey, employeeId, dotId: 'dot_fixture', conversationId: 'conv_fixture' }]);
    assert.equal(service.getState().unread, 0);
  } finally { service.close(); f.cleanup(); }
});
test('foreground snapshots remain available without distracting OS delivery', () => {
  const f = fixture(); const service = f.create();
  try {
    service.setEnabled(true); f.focus(true); service.receive(packet());
    assert.equal(f.shown.length, 0); assert.equal(service.getState().waiting, 1);
    service.setEnabled(false); f.focus(false); service.receive(packet()); assert.equal(f.shown.length, 0);
  } finally { service.close(); f.cleanup(); }
});
test('historical completions are not replayed and resolved attention clears badges', () => {
  const f = fixture(); const service = f.create();
  try {
    service.setEnabled(true);
    service.receive(packet({ waitingForAnswer: false, pendingCardId: null, lastAssistantMessageId: 'old_reply', lastAssistantAt: 1, unread: true }));
    assert.equal(f.shown.length, 0);
    service.receive(packet()); assert.equal(service.getState().unread, 1);
    service.receive(packet({ waitingForAnswer: false, pendingCardId: null }));
    assert.equal(service.getState().unread, 0); assert.equal(f.badges.at(-1), '');
  } finally { service.close(); f.cleanup(); }
});
test('scope changes remove old-account notifications and malformed snapshots fail closed', () => {
  const f = fixture(); const service = f.create();
  try {
    service.setEnabled(true); service.receive(packet()); const old = f.shown[0];
    const next = packet(); next.scopeKey = 'b'.repeat(64); service.receive(next);
    assert.equal(old.closed, true);
    assert.throws(() => normalizeAgentSnapshot({ ...packet(), scopeKey: 'forged' }), /Invalid/);
    const duplicate = packet(); duplicate.employees[0].rooms.push(duplicate.employees[0].rooms[0]);
    assert.throws(() => normalizeAgentSnapshot(duplicate), /Duplicate/);
  } finally { service.close(); f.cleanup(); }
});
