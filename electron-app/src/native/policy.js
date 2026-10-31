'use strict';
// Pure URL / sender policy for the desktop native bridge. Mirrors the allowlist
// in mobile-app/NATIVE_TRANSPORT.md so web code gets the same reach on every shell.

const CORE_HOST = 'api.singulancelabs.com';
const RUNNER_HOST = 'next.singulancelabs.com';
const ROOM_HOST = 'runtime-runner.singulancelabs.com';
const ROOM_HOSTS = [ROOM_HOST, 'dots.singulancelabs.com'];
const MAX_REQUEST_BODY = 8 * 1024 * 1024;
const MAX_RESPONSE_BODY = 20 * 1024 * 1024;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const CALLER_HEADERS = new Set(['accept', 'content-type']);
const RESPONSE_HEADERS = ['content-type', 'content-length', 'content-disposition', 'retry-after'];
const CREDENTIAL_KEYS = new Set(['pendingAuth', 'cpToken']);
const PREF_KEY = /^[A-Za-z0-9_.:-]{1,80}$/;
const ROOM_PATH = /^\/employees\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const APP_PATH = /^\/[A-Za-z0-9_\-./]{0,200}$/;

/** Parses and classifies a request URL; throws on anything outside the allowlist. */
function classifyRequest(rawUrl, method = 'GET') {
  if (typeof rawUrl !== 'string' || rawUrl.length > 2048) throw new Error('url');
  if (!METHODS.has(method)) throw new Error('method');
  // Encoded traversal / separators are refused before URL normalisation hides them.
  if (/%2e|%2f|%5c|\\/i.test(rawUrl)) throw new Error('path');
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error('url'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash || rawUrl.includes('#')) throw new Error('url');
  if (u.pathname.split('/').some((s) => s === '..' || s === '.')) throw new Error('path');
  if (u.hostname === CORE_HOST) {
    if (u.pathname.startsWith('/auth/mobile/') || u.pathname.startsWith('/v1/')) return { kind: 'core', url: u };
    throw new Error('path');
  }
  if (u.hostname === RUNNER_HOST) {
    if (u.pathname.startsWith('/api/')) return { kind: 'runner', url: u };
    if ((u.pathname.startsWith('/plugins/') || u.pathname.startsWith('/assets/')) && (method === 'GET' || method === 'HEAD')) {
      return { kind: 'runner', url: u };
    }
    throw new Error('path');
  }
  throw new Error('host');
}

/** Keeps only Accept and Content-Type from caller headers. */
function filterCallerHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [k, v] of Object.entries(headers)) {
    if (CALLER_HEADERS.has(k.toLowerCase()) && typeof v === 'string' && v.length <= 256 && !/[\r\n]/.test(v)) out[k.toLowerCase()] = v;
  }
  return out;
}

function filterResponseHeaders(headers) {
  const out = {};
  for (const name of RESPONSE_HEADERS) { const v = headers.get(name); if (v != null) out[name] = v; }
  return out;
}

/** Returns the room URL for an employee path, or throws. */
function roomUrl(path) {
  if (typeof path !== 'string' || !ROOM_PATH.test(path)) throw new Error('room');
  return `https://${ROOM_HOST}${path}?embed=hivemind`;
}

function isRoomNavigationAllowed(rawUrl) {
  try { const u = new URL(rawUrl); return u.protocol === 'https:' && !u.port && !u.username && ROOM_HOSTS.includes(u.hostname); }
  catch { return false; }
}

/** A room scope (signed-in company and person) is an opaque string of 1-200 characters, otherwise null. */
function roomScope(value) { return typeof value === 'string' && value.length >= 1 && value.length <= 200 ? value : null; }

/** The one message a room page may post to close itself (same object the iOS shell receives). */
function isRoomBackMessage(msg) {
  return !!msg && typeof msg === 'object' && !Array.isArray(msg) && msg.type === 'hivemind.open-dot.back' && msg.version === 1;
}

/** True for the product origin (any singulancelabs.com subdomain over https) or the bundled offline page. */
function isTrustedSender(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol === 'file:') return u.pathname.endsWith('/offline.html');
    return u.protocol === 'https:' && (u.hostname === 'singulancelabs.com' || u.hostname.endsWith('.singulancelabs.com'));
  } catch { return false; }
}

/** Validates a singulance:// link and returns a normalised string, or null. */
function parseDeepLink(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'singulance:' || u.username || u.password) return null;
    return u.toString();
  } catch { return null; }
}

/** In-app path for a notification click; only same-app relative paths. */
function safeAppPath(p) { return typeof p === 'string' && APP_PATH.test(p) && !p.includes('//') && !p.includes('..') ? p : null; }

/** Picks the secure hm_cp_session cookie from Set-Cookie lines; returns {name,value,domain|null} or null. */
function parseSessionCookie(lines) {
  for (const line of lines) {
    const parts = String(line).split(';').map((x) => x.trim());
    const [name, ...rest] = parts[0].split('=');
    if (name !== 'hm_cp_session' || !rest.length) continue;
    if (!parts.slice(1).some((a) => a.toLowerCase() === 'secure')) continue;
    const dom = parts.slice(1).find((a) => a.toLowerCase().startsWith('domain='));
    const domain = dom ? dom.slice(7).replace(/^\./, '').toLowerCase() : null;
    const out = { name, value: rest.join('='), domain: domain && (domain === 'singulancelabs.com' || domain.endsWith('.singulancelabs.com')) ? domain : null };
    const maxAge = parts.slice(1).find((a) => a.toLowerCase().startsWith('max-age='));
    const exp = parts.slice(1).find((a) => a.toLowerCase().startsWith('expires='));
    const seconds = maxAge ? Number(maxAge.slice(8)) : NaN;
    const at = exp ? Date.parse(exp.slice(8)) : NaN;
    if (Number.isFinite(seconds)) out.maxAgeSeconds = seconds;
    else if (Number.isFinite(at)) out.expiresAt = at;
    return out;
  }
  return null;
}

module.exports = {
  parseSessionCookie,
  CORE_HOST, RUNNER_HOST, ROOM_HOST, ROOM_HOSTS, MAX_REQUEST_BODY, MAX_RESPONSE_BODY, CREDENTIAL_KEYS, PREF_KEY,
  classifyRequest, filterCallerHeaders, filterResponseHeaders, roomUrl, roomScope, isRoomBackMessage, isRoomNavigationAllowed, isTrustedSender, parseDeepLink, safeAppPath,
};
