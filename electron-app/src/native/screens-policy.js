'use strict';
// Pure request policy for the on-device screens cache. Decides which GET requests may be answered
// from (or stored into) the local bundle; everything else is passed to the network untouched.

const SCREEN_HOSTS = ['singulancelabs.com', 'runtime-runner.singulancelabs.com', 'dots.singulancelabs.com'];
const APP_HOST = 'singulancelabs.com';
const APP_PREFIX = '/hivemind/app';
const SHELL_FROM_SERVER = new Set(['dots.singulancelabs.com']);
const MANIFEST_PATH = '/ui-manifest.json';
const MAX_PATH = 300;

// Anything that carries data, identity or a long-lived connection is never served or stored locally.
const DENY_FIRST_SEGMENT = new Set([
  'api', 'auth', 'v1', 'oauth', 'login', 'logout', 'signin', 'signout', 'callback', 'stream', 'streams', 'events', 'sse',
  'ws', 'socket', 'socket.io', 'upload', 'uploads', 'download', 'downloads', 'files', 'webhook', 'webhooks', 'graphql', 'trpc', 'rpc',
]);
const DENY_ANY_SEGMENT = new Set(['api', 'stream', 'streams', 'sse', 'ws', 'upload', 'uploads', 'webhook', 'webhooks', 'oauth']);
const ASSET_DIRS = new Set(['static', 'assets', '_next', 'chunks', 'fonts', 'media', 'build']);
const EXT = /\.(js|mjs|css|woff2?|ttf|otf|png|jpe?g|gif|webp|avif|svg|ico|json|txt|webmanifest|map)$/i;
const HASHED = /[.\-_]([0-9A-Za-z_-]{8,})\.(js|mjs|css|woff2?|ttf|otf|png|jpe?g|gif|webp|avif|svg|ico)$/;

const CONTENT_TYPES = {
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8', json: 'application/json', txt: 'text/plain; charset=utf-8', map: 'application/json',
  webmanifest: 'application/manifest+json', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  svg: 'image/svg+xml', ico: 'image/x-icon',
};

function contentTypeFor(relPath) {
  const m = /\.([A-Za-z0-9]+)$/.exec(relPath);
  return (m && CONTENT_TYPES[m[1].toLowerCase()]) || 'application/octet-stream';
}

/** Normalises a URL pathname or manifest path to a relative bundle path, or null if unsafe. */
function safeRel(p) {
  if (typeof p !== 'string' || !p || p.length > MAX_PATH || /[\0\\]|%2e|%2f|%5c/i.test(p)) return null;
  const segs = p.replace(/^\/+/, '').split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return null;
  return segs.join('/');
}

function hasHash(base) {
  const m = HASHED.exec(base);
  if (!m) return false;
  const h = m[1];
  return /[0-9]/.test(h) || (/[a-z]/.test(h) && /[A-Z]/.test(h));
}

function denied(segs) {
  if (segs.length && (DENY_FIRST_SEGMENT.has(segs[0].toLowerCase()) || (segs[0].startsWith('_') && segs[0] !== '_next'))) return true;
  return segs.some((s) => DENY_ANY_SEGMENT.has(s.toLowerCase()));
}

function header(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return String(v);
  return '';
}

/**
 * Classifies a request. kind is one of:
 *  - 'asset'  hashed static file: local bundle first, then network (network copy is stored)
 *  - 'bundle' other static file: served only if the active bundle lists it, never stored from the network
 *  - 'shell'  HTML navigation of an app/room page: served from the bundle shell if one is present
 *  - 'pass'   everything else (never touched)
 */
function classifyScreenRequest({ url, method = 'GET', headers } = {}) {
  const pass = { kind: 'pass' };
  if (method !== 'GET') return pass;
  if (typeof url !== 'string' || url.length > 2048) return pass;
  let u;
  try { u = new URL(url); } catch { return pass; }
  if (u.protocol !== 'https:' || u.port || u.username || u.password) return pass;
  const host = u.hostname.toLowerCase();
  if (!SCREEN_HOSTS.includes(host)) return pass;
  if (header(headers, 'range') || header(headers, 'authorization') || header(headers, 'x-requested-with')) return pass;
  if (u.pathname === MANIFEST_PATH) return pass;
  const rel = safeRel(u.pathname);
  const segs = rel ? rel.split('/') : [];
  if (u.pathname !== '/' && !rel) return pass;
  if (denied(segs)) return pass;
  const base = segs.length ? segs[segs.length - 1] : '';
  if (base && EXT.test(base)) {
    const inAssetDir = segs.slice(0, -1).some((s) => ASSET_DIRS.has(s.toLowerCase()));
    return hasHash(base) && inAssetDir ? { kind: 'asset', host, rel } : { kind: 'bundle', host, rel };
  }
  const accept = header(headers, 'accept');
  const dest = header(headers, 'sec-fetch-dest').toLowerCase();
  const isDocument = accept.includes('text/html') && (!dest || dest === 'document' || dest === 'iframe');
  if (!isDocument) return pass;
  if (host === APP_HOST) {
    const inApp = u.pathname === APP_PREFIX || u.pathname.startsWith(`${APP_PREFIX}/`);
    return inApp ? { kind: 'shell', host } : pass;
  }
  // OpenDot renders each room on the server (Next.js), so one stored shell cannot stand in for every room page;
  // its own service worker keeps room shells per account. Only its hashed assets are served from here.
  if (SHELL_FROM_SERVER.has(host)) return pass;
  return { kind: 'shell', host };
}

module.exports = { SCREEN_HOSTS, APP_HOST, MANIFEST_PATH, classifyScreenRequest, safeRel, contentTypeFor, hasHash };
