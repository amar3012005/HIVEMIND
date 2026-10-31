'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TokenStore } = require('../src/native/token-store');

const fakeSafe = (over = {}) => ({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
  decryptString: (b) => { const t = b.toString(); if (!t.startsWith('enc:')) throw new Error('bad'); return Buffer.from(t.slice(4), 'base64').toString(); },
  ...over,
});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tok-'));

test('round trip stores ciphertext only', () => {
  const dir = tmp(); const s = new TokenStore({ safeStorage: fakeSafe(), dir });
  s.set('cpToken', 'secret-token-123');
  assert.equal(s.get('cpToken'), 'secret-token-123');
  for (const f of fs.readdirSync(dir)) assert.ok(!fs.readFileSync(path.join(dir, f)).toString().includes('secret-token-123'));
  s.remove('cpToken');
  assert.equal(s.get('cpToken'), null);
});

test('unknown keys and bad values are refused', () => {
  const s = new TokenStore({ safeStorage: fakeSafe(), dir: tmp() });
  assert.throws(() => s.set('other', 'x'));
  assert.throws(() => s.get('../x'));
  assert.throws(() => s.set('cpToken', ''));
  assert.throws(() => s.set('cpToken', 'x'.repeat(20000)));
  assert.throws(() => s.set('cpToken', 5));
});

test('no plaintext fallback when encryption is unavailable', () => {
  const dir = tmp();
  const s = new TokenStore({ safeStorage: fakeSafe({ isEncryptionAvailable: () => false }), dir });
  assert.throws(() => s.set('cpToken', 'x'));
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(s.get('cpToken'), null);
  const linux = new TokenStore({ safeStorage: fakeSafe({ getSelectedStorageBackend: () => 'basic_text' }), dir });
  assert.throws(() => linux.set('cpToken', 'x'));
});

test('undecryptable value is dropped; clear removes all', () => {
  const dir = tmp(); const s = new TokenStore({ safeStorage: fakeSafe(), dir });
  fs.writeFileSync(path.join(dir, 'cred-cpToken.bin'), 'garbage');
  assert.equal(s.get('cpToken'), null);
  assert.ok(!fs.existsSync(path.join(dir, 'cred-cpToken.bin')));
  s.set('cpToken', 'a'); s.set('pendingAuth', 'b'); s.clear();
  assert.deepEqual(fs.readdirSync(dir), []);
});
