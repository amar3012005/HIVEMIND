'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNotifier, resolveDeepLink, normalizePrefs, inQuietHours } = require('../src/native/notifier');
const { normalizeStatus, buildTrayTemplate } = require('../src/native/tray-menu');
const { createLoginItem } = require('../src/native/login-item');
const { createBridge } = require('../src/native/bridge');

function fakeNotification() {
  const made = [];
  class N {
    constructor(opts) { this.opts = opts; this.h = {}; made.push(this); }
    on(e, f) { this.h[e] = f; }
    show() { this.shown = true; }
    static isSupported() { return true; }
  }
  return { N, made };
}
function setup(extra = {}) {
  const { N, made } = fakeNotification();
  const routed = []; const actions = [];
  const notifier = createNotifier({ Notification: N, onClick: () => {}, onDeepLink: (l, id) => routed.push([l, id]), onAction: (a) => actions.push(a), ...extra });
  return { notifier, made, routed, actions };
}
const base = { title: 'Ava needs you', body: 'Approve the invoice', category: 'needs_you', employeeName: 'Ava', deepLink: '/employees/abc', id: 'n1' };

test('payload validation', () => {
  const { notifier } = setup();
  assert.throws(() => notifier.show({ ...base, title: '' }), /title/);
  assert.throws(() => notifier.show({ ...base, category: 'spam' }), /category/);
  assert.throws(() => notifier.show({ ...base, deepLink: 'https://evil.com/x' }), /deepLink/);
  assert.throws(() => notifier.show({ ...base, deepLink: 'javascript:alert(1)' }), /deepLink/);
  assert.throws(() => notifier.show({ ...base, avatarUrl: 'https://evil.com/a.png' }), /avatarUrl/);
  assert.throws(() => notifier.show({ ...base, actions: [{ id: 'delete', title: 'x' }] }), /actions/);
  assert.throws(() => notifier.show({ ...base, actions: [{ id: 'open', title: 'a' }, { id: 'open', title: 'b' }] }), /actions/);
});

test('grouping per employee, sound only for needs_you, no reply', () => {
  const { notifier, made } = setup();
  notifier.show(base);
  notifier.show({ ...base, category: 'results', title: 'Done' });
  assert.equal(made[0].opts.subtitle, 'Ava'); assert.equal(made[0].opts.groupId, 'employee:Ava');
  assert.equal(made[0].opts.silent, false); assert.equal(made[0].opts.hasReply, false);
  assert.equal(made[1].opts.silent, true);
  assert.equal(made[1].opts.groupId, made[0].opts.groupId);
});

test('deep link allowlist applies on click and open action', () => {
  assert.equal(resolveDeepLink('/employees/abc'), 'singulance://app/employees/abc');
  assert.equal(resolveDeepLink('https://next.singulancelabs.com/hivemind/app/overview?x=1'), 'singulance://app/hivemind/app/overview?x=1');
  assert.equal(resolveDeepLink('https://singulancelabs.com.evil.com/x'), null);
  assert.equal(resolveDeepLink('http://next.singulancelabs.com/x'), null);
  assert.equal(resolveDeepLink('//evil.com'), null);
  const { notifier, made, routed } = setup();
  notifier.show({ ...base, actions: [{ id: 'open', title: 'Open' }] });
  made[0].h.click();
  made[0].h.action({}, 0);
  assert.deepEqual(routed, [['singulance://app/employees/abc', 'n1'], ['singulance://app/employees/abc', 'n1']]);
});

test('approve and not_now are forwarded to the renderer, never handled in main', () => {
  const { notifier, made, routed, actions } = setup();
  notifier.show({ ...base, actions: [{ id: 'approve', title: 'Approve' }, { id: 'not_now', title: 'Not now' }] });
  assert.deepEqual(made[0].opts.actions.map((a) => a.text), ['Approve', 'Not now']);
  made[0].h.action({}, 0); made[0].h.action({}, 1); made[0].h.action({}, 9);
  assert.deepEqual(actions, [{ id: 'n1', action: 'approve' }, { id: 'n1', action: 'not_now' }]);
  assert.equal(routed.length, 0);
});

test('prefs: category off and quiet hours', () => {
  const t = new Date(2026, 10, 1, 23, 30);
  const { notifier, made } = setup({ now: () => t });
  notifier.setPrefs({ categories: { briefs: false } });
  assert.equal(notifier.show({ ...base, category: 'briefs' }).shown, false);
  notifier.setPrefs({ quietHours: { enabled: true, start: '22:00', end: '07:00' } });
  assert.equal(notifier.show({ ...base, category: 'results' }).reason, 'quiet');
  assert.equal(notifier.show(base).shown, true);
  assert.equal(made[0].opts.silent, true, 'needs_you is delivered silently in quiet hours');
  assert.equal(inQuietHours(normalizePrefs({ quietHours: { enabled: true, start: '09:00', end: '17:00' } }).quietHours, t), false);
  assert.equal(normalizePrefs({ quietHours: { enabled: true, start: '25:00', end: '07:00' } }).quietHours.enabled, false);
});

test('legacy payload still works', () => {
  const clicks = []; const { N, made } = fakeNotification();
  const n = createNotifier({ Notification: N, onClick: (p, id) => clicks.push([p, id]) });
  n.show({ id: 'a', title: 'T', path: '/x' }); made[0].h.click();
  assert.deepEqual(clicks, [['/x', 'a']]);
  assert.throws(() => n.show({ title: 'T', path: '//evil' }), /path/);
});

test('tray menu is built from status', () => {
  const st = normalizeStatus({ needsYou: 3, working: Array.from({ length: 7 }, (_, i) => ({ name: `E${i}`, step: 'Drafting' })) });
  assert.equal(st.working.length, 5);
  const calls = [];
  const t = buildTrayTemplate(st, { openAtLogin: true, onOpen: () => calls.push('open'), onToggleLogin: () => calls.push('login'), onQuit: () => calls.push('quit') });
  const labels = t.map((i) => i.label).filter(Boolean);
  assert.ok(labels.includes('Needs you: 3')); assert.ok(labels.includes('E0: Drafting')); assert.ok(!labels.includes('E5: Drafting'));
  assert.equal(t.find((i) => i.label === 'Open at login').checked, true);
  t.find((i) => i.label === 'Open SINGULANCE').click(); t.find((i) => i.label === 'Quit SINGULANCE').click();
  assert.deepEqual(calls, ['open', 'quit']);
  assert.deepEqual(normalizeStatus('junk'), { needsYou: 0, working: [] });
  assert.ok(buildTrayTemplate(normalizeStatus(), {}).some((i) => i.label === 'Nothing needs you'));
});

test('login item toggle opens hidden', () => {
  const calls = []; let on = false;
  const app = { getLoginItemSettings: () => ({ openAtLogin: on }), setLoginItemSettings: (s) => { calls.push(s); on = s.openAtLogin; } };
  const li = createLoginItem({ app });
  assert.deepEqual(li.get(), { enabled: false });
  assert.deepEqual(li.set(true), { enabled: true });
  assert.deepEqual(calls[0], { openAtLogin: true, openAsHidden: true });
  assert.throws(() => li.set('yes'), /enabled/);
});

test('bridge routes prefs, tray status and login item', () => {
  const seen = {};
  const b = createBridge({ tokenStore: {}, notifier: { setPrefs: (p) => { seen.prefs = p; } }, setTrayStatus: (s) => { seen.tray = s; }, loginItem: { get: () => ({ enabled: false }), set: (e) => ({ enabled: e }) }, setUnread() {}, rooms: {}, prefsFile: '/x' });
  b.handlers['native:notify-prefs']({ quietHours: {} }); b.handlers['native:tray-status']({ needsYou: 2 });
  assert.deepEqual(seen, { prefs: { quietHours: {} }, tray: { needsYou: 2 } });
  assert.deepEqual(b.handlers['native:login-item:set']({ enabled: true }), { enabled: true });
});
