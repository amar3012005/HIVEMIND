import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolkitStatusFromAccounts } from '../../src/connectors/composio/composio-service.js';

test('gmail is connected from ACTIVE accounts even without COMPOSIO_AUTH_CONFIGS', () => {
  assert.equal(toolkitStatusFromAccounts('gmail', [
    { toolkit: 'gmail', status: 'ACTIVE' },
  ]), 'connected');
});

test('gmail stays available when only INITIATED or missing', () => {
  assert.equal(toolkitStatusFromAccounts('gmail', []), 'available');
  assert.equal(toolkitStatusFromAccounts('gmail', [
    { toolkit: 'gmail', status: 'INITIATED' },
  ]), 'available');
});
