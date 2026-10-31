'use strict';
// On-device screens bundle: <root>/<host>/<version>/{meta.json,files/...} plus <root>/<host>/_cache/ for hashed
// assets seen on the network (immutable by name). Only public code lives here, never user data.
const fs = require('fs');
const path = require('path');
const policy = require('./screens-policy');

const VERSION = /^[A-Za-z0-9._-]{1,64}$/;
const COMPLETE = 'meta.json';

class ScreensStore {
  constructor({ root, keep = 2, maxCacheBytes = 256 * 1024 * 1024 }) {
    this.root = root; this.keep = keep; this.maxCacheBytes = maxCacheBytes;
    this.active = new Map(); // host -> { version, dir, shell }
  }

  hostDir(host) {
    if (!policy.SCREEN_HOSTS.includes(host)) throw new Error('host');
    return path.join(this.root, host);
  }

  static validVersion(v) { return typeof v === 'string' && VERSION.test(v) && v !== '_cache'; }

  /** Complete versions of a host, newest first. */
  versions(host) {
    const dir = this.hostDir(host);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; /* no bundle for this host yet */ }
    const out = [];
    for (const name of names) {
      if (!ScreensStore.validVersion(name)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, name, COMPLETE), 'utf8'));
        out.push({ version: name, at: Number(meta.at) || 0, shell: typeof meta.shell === 'string' ? meta.shell : null });
      } catch { /* incomplete or unreadable version dir: ignored */ }
    }
    return out.sort((a, b) => b.at - a.at || (a.version < b.version ? 1 : -1));
  }

  hasVersion(host, version) { return this.versions(host).some((v) => v.version === version); }

  /** Pins the newest complete version per host for the lifetime of the next windows. */
  activate() {
    this.active.clear();
    for (const host of policy.SCREEN_HOSTS) {
      const newest = this.versions(host)[0];
      if (newest) this.active.set(host, { version: newest.version, dir: path.join(this.hostDir(host), newest.version, 'files'), shell: newest.shell });
    }
    return Object.fromEntries([...this.active].map(([h, a]) => [h, a.version]));
  }

  _resolve(base, rel) {
    const safe = policy.safeRel(rel);
    if (!safe) return null;
    const full = path.join(base, safe);
    return full.startsWith(base + path.sep) ? full : null;
  }

  _read(base, rel) {
    const full = this._resolve(base, rel);
    if (!full) return null;
    try { return fs.readFileSync(full); } catch { return null; /* not in this location */ }
  }

  /** Bundle file for a host: active version first, then the network-seen cache. */
  read(host, rel) {
    const act = this.active.get(host);
    if (act) { const d = this._read(act.dir, rel); if (d) return { data: d, source: 'bundle' }; }
    const c = this._read(path.join(this.hostDir(host), '_cache'), rel);
    return c ? { data: c, source: 'cache' } : null;
  }

  readShell(host) {
    const act = this.active.get(host);
    if (!act || !act.shell) return null;
    const d = this._read(act.dir, act.shell);
    return d ? { data: d, source: 'bundle' } : null;
  }

  writeCache(host, rel, data) {
    const full = this._resolve(path.join(this.hostDir(host), '_cache'), rel);
    if (!full) return false;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const tmp = `${full}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, full);
    return true;
  }

  /** Starts a new version in a temporary directory; commit() makes it visible, abort() discards it. */
  beginVersion(host, version, shell = null) {
    if (!ScreensStore.validVersion(version)) throw new Error('version');
    const hostDir = this.hostDir(host);
    const tmp = path.join(hostDir, `.tmp-${version}-${process.pid}-${Date.now()}`);
    const filesDir = path.join(tmp, 'files');
    fs.mkdirSync(filesDir, { recursive: true });
    return {
      write: (rel, data) => {
        const full = this._resolve(filesDir, rel);
        if (!full) throw new Error('path');
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, data);
      },
      commit: () => {
        fs.writeFileSync(path.join(tmp, COMPLETE), JSON.stringify({ version, at: Date.now(), shell }));
        const finalDir = path.join(hostDir, version);
        fs.rmSync(finalDir, { recursive: true, force: true });
        fs.renameSync(tmp, finalDir);
        this.prune(host);
      },
      abort: () => fs.rmSync(tmp, { recursive: true, force: true }),
    };
  }

  /** Keeps the newest `keep` complete versions (never the active one), removes leftovers of failed downloads, trims the cache. */
  prune(host) {
    const hostDir = this.hostDir(host);
    const keepSet = new Set(this.versions(host).slice(0, this.keep).map((v) => v.version));
    const act = this.active.get(host); if (act) keepSet.add(act.version);
    let names = [];
    try { names = fs.readdirSync(hostDir); } catch { return; /* nothing stored */ }
    for (const name of names) {
      if (name === '_cache') continue;
      const stale = name.startsWith('.tmp-') ? this._age(path.join(hostDir, name)) > 3600e3 : !keepSet.has(name);
      if (stale) fs.rmSync(path.join(hostDir, name), { recursive: true, force: true });
    }
    this._trimCache(path.join(hostDir, '_cache'));
  }

  _age(p) { try { return Date.now() - fs.statSync(p).mtimeMs; } catch { return Infinity; /* already gone */ } }

  _trimCache(dir) {
    const files = [];
    const walk = (d) => {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; /* cache dir absent */ }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else { const st = fs.statSync(p); files.push({ p, size: st.size, t: st.mtimeMs }); }
      }
    };
    walk(dir);
    let total = files.reduce((n, f) => n + f.size, 0);
    for (const f of files.sort((a, b) => a.t - b.t)) {
      if (total <= this.maxCacheBytes) break;
      fs.rmSync(f.p, { force: true }); total -= f.size;
    }
  }

  /** Removes every stored screen (sign-out). */
  clear() {
    this.active.clear();
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

module.exports = { ScreensStore };
