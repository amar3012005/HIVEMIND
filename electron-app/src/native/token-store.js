'use strict';
// Session credentials live only in the main process, encrypted with Electron safeStorage
// (macOS Keychain, Windows DPAPI, Linux libsecret/kwallet). Nothing reaches renderer storage.
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { CREDENTIAL_KEYS } = require('./policy');

const MAX_VALUE = 16 * 1024;

class TokenStore {
  /** @param {{safeStorage: object, dir: string, fs?: object}} deps */
  constructor({ safeStorage, dir, fs = nodeFs }) { this.safe = safeStorage; this.dir = dir; this.fs = fs; }

  available() {
    try {
      if (!this.safe.isEncryptionAvailable()) return false;
      // Linux without a keyring falls back to a hard-coded key: treat as unavailable.
      if (typeof this.safe.getSelectedStorageBackend === 'function' && this.safe.getSelectedStorageBackend() === 'basic_text') return false;
      return true;
    } catch { return false; }
  }

  file(key) {
    if (!CREDENTIAL_KEYS.has(key)) throw new Error('credential key');
    return nodePath.join(this.dir, `cred-${key}.bin`);
  }

  set(key, value) {
    const file = this.file(key);
    if (typeof value !== 'string' || !value || value.length > MAX_VALUE) throw new Error('credential value');
    if (!this.available()) throw new Error('secure storage unavailable');
    this.fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${file}.tmp`;
    this.fs.writeFileSync(tmp, this.safe.encryptString(value), { mode: 0o600 });
    this.fs.renameSync(tmp, file);
  }

  get(key) {
    const file = this.file(key);
    let bytes;
    try { bytes = this.fs.readFileSync(file); } catch { return null; } // missing file means not signed in; safeStorage is not touched
    if (!this.available()) return null;
    try { return this.safe.decryptString(bytes); } catch { this.remove(key); return null; } // undecryptable: drop it
  }

  remove(key) {
    const file = this.file(key);
    try { this.fs.unlinkSync(file); } catch { /* already absent */ }
  }

  clear() { for (const key of CREDENTIAL_KEYS) this.remove(key); }
}

module.exports = { TokenStore };
