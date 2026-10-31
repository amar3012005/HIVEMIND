'use strict';
// Background updater: reads https://<host>/ui-manifest.json and downloads a missing version into the store.
const crypto = require('crypto');
const policy = require('./screens-policy');
const { ScreensStore } = require('./screens-store');

const MAX_MANIFEST = 1024 * 1024;
const MAX_FILE = 20 * 1024 * 1024;
const MAX_TOTAL = 150 * 1024 * 1024;
const MAX_FILES = 2000;
const CONCURRENCY = 4;
const EVERY_MS = 30 * 60 * 1000;

/** Accepts {version, shell?, files:[string|{path,size?,sha256?}]}; returns a normalised manifest or null. */
function parseManifest(text) {
  let j;
  try { j = JSON.parse(text); } catch { return null; /* not JSON: treated as no manifest */ }
  if (!j || typeof j !== 'object' || !ScreensStore.validVersion(j.version) || !Array.isArray(j.files) || j.files.length > MAX_FILES) return null;
  const files = [];
  for (const f of j.files) {
    const e = typeof f === 'string' ? { path: f } : f;
    const rel = e && policy.safeRel(e.path);
    if (!rel) return null;
    const sha256 = e.sha256 == null ? null : String(e.sha256).toLowerCase();
    if (sha256 !== null && !/^[0-9a-f]{64}$/.test(sha256)) return null;
    const size = e.size == null ? null : e.size;
    if (size !== null && (!Number.isInteger(size) || size < 0 || size > MAX_FILE)) return null;
    files.push({ rel, sha256, size });
  }
  let shell = null;
  if (j.shell != null) {
    shell = policy.safeRel(j.shell);
    if (!shell) return null;
    if (!files.some((f) => f.rel === shell)) files.push({ rel: shell, sha256: null, size: null });
  }
  return { version: j.version, shell, files };
}

function createUpdater({ store, fetch, hosts = policy.SCREEN_HOSTS, log = () => {}, intervalMs = EVERY_MS }) {
  let timer = null;
  const running = new Map();

  async function readCapped(res, cap) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > cap) throw new Error('too large');
    return buf;
  }

  async function download(host, manifest) {
    const v = store.beginVersion(host, manifest.version, manifest.shell);
    let total = 0;
    try {
      const queue = manifest.files.slice();
      const worker = async () => {
        for (let f = queue.shift(); f; f = queue.shift()) {
          const res = await fetch(new URL(`/${f.rel}`, `https://${host}`).toString());
          if (!res.ok) throw new Error(`${f.rel} ${res.status}`);
          const buf = await readCapped(res, MAX_FILE);
          total += buf.length;
          if (total > MAX_TOTAL) throw new Error('bundle too large');
          if (f.size !== null && buf.length !== f.size) throw new Error(`${f.rel} size`);
          if (f.sha256 !== null && crypto.createHash('sha256').update(buf).digest('hex') !== f.sha256) throw new Error(`${f.rel} hash`);
          v.write(f.rel, buf);
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
      v.commit();
    } catch (err) { v.abort(); throw err; }
  }

  async function checkHost(host) {
    let res;
    try { res = await fetch(`https://${host}${policy.MANIFEST_PATH}`, { headers: { accept: 'application/json' } }); }
    catch (err) { return { host, status: 'offline' }; }
    if (!res.ok) return { host, status: 'none' }; // 404 until the host publishes a manifest
    let manifest;
    try { manifest = parseManifest((await readCapped(res, MAX_MANIFEST)).toString('utf8')); } catch { manifest = null; /* oversized body */ }
    if (!manifest) return { host, status: 'invalid' };
    if (store.hasVersion(host, manifest.version)) return { host, status: 'current', version: manifest.version };
    try { await download(host, manifest); } catch (err) { log('screens update failed', host, err.message); return { host, status: 'failed', version: manifest.version }; }
    log('screens downloaded', host, manifest.version);
    return { host, status: 'downloaded', version: manifest.version };
  }

  function checkAll() {
    return Promise.all(hosts.map((h) => {
      if (!running.has(h)) running.set(h, checkHost(h).finally(() => running.delete(h)));
      return running.get(h);
    }));
  }

  function start() {
    if (timer) return;
    checkAll().catch(() => {});
    timer = setInterval(() => { checkAll().catch(() => {}); }, intervalMs);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { checkHost, checkAll, start, stop };
}

module.exports = { createUpdater, parseManifest, EVERY_MS };
