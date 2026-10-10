import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overlayActiveApps } from '../../src/connectors/connected-app-overlay.js';
test('all active accounts appear without catalog lookup, including uncurated toolkits', () => {
  const accounts = [{ toolkit: 'gmail', status: 'ACTIVE', id: 'private-receipt' },
    { toolkit: 'custom_toolkit', status: 'ACTIVE' }, { toolkit: 'expired', status: 'EXPIRED' },
    { toolkit: '../invalid', status: 'ACTIVE' }];
  const original = [{ provider: 'gmail', label: 'Gmail', status: 'available' }];
  const rows = overlayActiveApps(original, accounts, true);
  assert.deepEqual(rows.map(row => row.provider), ['gmail', 'custom_toolkit', 'slack']);
  assert.equal(rows[0].status, 'connected'); assert.equal(rows[0].label, 'Gmail');
  assert.equal(rows[2].source, 'native'); assert.equal(original[0].status, 'available');
  assert.equal(JSON.stringify(rows).includes('private-receipt'), false);
});
test('inactive accounts never downgrade existing active connections', () => {
  const rows = overlayActiveApps([{ provider: 'slack', status: 'connected' }], [{ toolkit: 'slack', status: 'FAILED' }]);
  assert.equal(rows[0].status, 'connected');
});
