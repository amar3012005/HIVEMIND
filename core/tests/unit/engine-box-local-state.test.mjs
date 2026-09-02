import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { consumeSetupToken, readSetupRecord, writeSetupRecord } from '../../../engine-box/lib/local-state.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-box-state-'));
  const token = path.join(root, 'setup-token');
  const key = path.join(root, 'state-key');
  await fs.writeFile(token, 'a'.repeat(32), { mode: 0o600 });
  await fs.writeFile(key, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  return { root, env: { ENGINE_BOX_STATE_DIR: path.join(root, 'state'), ENGINE_BOX_SETUP_TOKEN_FILE: token, ENGINE_BOX_STATE_KEY_FILE: key } };
}

test('Engine Box encrypts configuration at rest and restores it with its local state key', async () => {
  const { root, env } = await fixture();
  try {
    const record = { state: 'configured', oidc: { client_secret: 'never-plaintext' }, model_routes: { chat: { api_key: 'also-secret' } } };
    await writeSetupRecord(record, env);
    const raw = await fs.readFile(path.join(env.ENGINE_BOX_STATE_DIR, 'setup.enc.json'), 'utf8');
    assert.ok(!raw.includes('never-plaintext'));
    assert.deepEqual(await readSetupRecord(env), record);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Engine Box setup token is constant-time checked and single use', async () => {
  const { root, env } = await fixture();
  try {
    assert.equal(await consumeSetupToken('b'.repeat(32), env), false);
    assert.equal(await consumeSetupToken('a'.repeat(32), env), true);
    assert.equal(await consumeSetupToken('a'.repeat(32), env), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
