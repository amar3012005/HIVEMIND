import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { registerEmbeddedAmrOrg, unregisterEmbeddedAmrOrg } from '../../src/storage/amr-registry.js';

test('embedded AMR registration is durable and preserves existing routes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-registry-'));
  const file = path.join(dir, 'agents.json');
  fs.writeFileSync(file, JSON.stringify({ enterprise: { url: 'https://agent.example', kind: 'selfhost' } }));

  registerEmbeddedAmrOrg('personal', file);
  const registered = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(registered.personal, { url: 'local:', token: '', kind: 'amr-central' });
  assert.equal(registered.enterprise.kind, 'selfhost');

  assert.equal(unregisterEmbeddedAmrOrg('personal', file), true);
  const cleaned = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cleaned.personal, undefined);
  assert.equal(cleaned.enterprise.kind, 'selfhost');
});

test('cleanup never removes a non-embedded route', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-registry-'));
  const file = path.join(dir, 'agents.json');
  fs.writeFileSync(file, JSON.stringify({ customer: { url: 'https://agent.example', kind: 'selfhost' } }));
  assert.equal(unregisterEmbeddedAmrOrg('customer', file), false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).customer.kind, 'selfhost');
});
