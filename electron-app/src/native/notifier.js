'use strict';
// Native notifications. Click or the "open" action focuses the window and hands the renderer a validated
// deep link; "approve" / "not_now" are forwarded to the renderer, which decides (main never approves).
const policy = require('./policy');

const CATEGORIES = Object.freeze(['needs_you', 'results', 'briefs']);
const ACTION_IDS = Object.freeze(['open', 'approve', 'not_now']);
const MAX_ACTIONS = 3;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Validated deep link: an in-app path, a singulance:// link, or an https URL on a product host. Returns a singulance:// string or null. */
function resolveDeepLink(raw) {
  if (typeof raw !== 'string') return null;
  const asPath = policy.safeAppPath(raw);
  if (asPath) return `singulance://app${asPath}`;
  if (raw.startsWith('singulance:')) return policy.parseDeepLink(raw);
  if (raw.length > 2048) return null;
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:' && !u.username && !u.password && !u.port && policy.isTrustedSender(raw)) {
      const p = policy.safeAppPath(u.pathname);
      return p ? `singulance://app${p}${u.search}` : null;
    }
  } catch { /* not a URL */ }
  return null;
}

function minutes(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }

/** Normalises renderer preferences: { categories: {needs_you,results,briefs: boolean}, quietHours: {enabled,start,end} }. */
function normalizePrefs(p = {}) {
  const categories = {};
  for (const c of CATEGORIES) categories[c] = !(p.categories && p.categories[c] === false);
  const q = p.quietHours || {};
  const quietHours = q.enabled === true && HHMM.test(q.start) && HHMM.test(q.end) ? { enabled: true, start: q.start, end: q.end } : { enabled: false, start: '22:00', end: '07:00' };
  return { categories, quietHours };
}

function inQuietHours(q, date) {
  if (!q.enabled) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  const s = minutes(q.start); const e = minutes(q.end);
  if (s === e) return false;
  return s < e ? now >= s && now < e : now >= s || now < e;
}

function createNotifier({ Notification, onClick, onDeepLink, onAction, now = () => new Date() }) {
  const live = new Set(); // keep references so notifications are not garbage collected before click
  let prefs = normalizePrefs();

  function focusAndRoute(link, id) { (onDeepLink || onClick)(link, id); }

  function showLegacy({ id, title, body, path }) {
    if (!Notification.isSupported()) return { shown: false };
    const target = path == null ? null : policy.safeAppPath(path);
    if (path != null && !target) throw new Error('path');
    const n = new Notification({ title, body: body || '', silent: false });
    live.add(n);
    n.on('click', () => onClick(target, typeof id === 'string' ? id.slice(0, 80) : null));
    n.on('close', () => live.delete(n));
    n.show();
    return { shown: true };
  }

  return {
    setPrefs(p) { prefs = normalizePrefs(p); return prefs; },
    getPrefs: () => prefs,
    show(payload = {}) {
      const { id, title, body, category, employeeName, avatarUrl, deepLink, actions, path } = payload;
      if (typeof title !== 'string' || !title || title.length > 120) throw new Error('title');
      if (body != null && (typeof body !== 'string' || body.length > 400)) throw new Error('body');
      if (category === undefined && deepLink === undefined && actions === undefined) return showLegacy({ id, title, body, path });
      if (!CATEGORIES.includes(category)) throw new Error('category');
      if (employeeName != null && (typeof employeeName !== 'string' || employeeName.length > 80)) throw new Error('employeeName');
      if (avatarUrl != null && (typeof avatarUrl !== 'string' || avatarUrl.length > 2048 || !/^https:\/\//.test(avatarUrl) || !policy.isTrustedSender(avatarUrl))) throw new Error('avatarUrl');
      const link = deepLink == null ? null : resolveDeepLink(deepLink);
      if (deepLink != null && !link) throw new Error('deepLink');
      let acts = [];
      if (actions != null) {
        if (!Array.isArray(actions) || actions.length > MAX_ACTIONS) throw new Error('actions');
        const seen = new Set();
        acts = actions.map((a) => {
          if (!a || !ACTION_IDS.includes(a.id) || seen.has(a.id) || typeof a.title !== 'string' || !a.title || a.title.length > 40) throw new Error('actions');
          seen.add(a.id);
          return { id: a.id, title: a.title };
        });
      }
      if (!Notification.isSupported()) return { shown: false };
      if (!prefs.categories[category]) return { shown: false, reason: 'category' };
      const quiet = inQuietHours(prefs.quietHours, now());
      if (quiet && category !== 'needs_you') return { shown: false, reason: 'quiet' };
      const nid = typeof id === 'string' ? id.slice(0, 80) : null;
      const opts = {
        title, body: body || '', silent: category !== 'needs_you' || quiet, hasReply: false,
        groupId: employeeName ? `employee:${employeeName}` : undefined,
        subtitle: employeeName || undefined,
      };
      if (acts.length) opts.actions = acts.map((a) => ({ type: 'button', text: a.title }));
      const n = new Notification(opts);
      live.add(n);
      n.on('click', () => focusAndRoute(link, nid));
      n.on('action', (_e, index) => {
        const a = acts[index];
        if (!a) return;
        if (a.id === 'open') focusAndRoute(link, nid);
        else if (onAction) onAction({ id: nid, action: a.id });
      });
      n.on('close', () => live.delete(n));
      n.show();
      return { shown: true };
    },
  };
}

module.exports = { createNotifier, resolveDeepLink, normalizePrefs, inQuietHours, CATEGORIES, ACTION_IDS };
