import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileAllGmailWatches } from '../../src/connectors/providers/gmail/gmail-watcher-service.js';

test('scheduled Gmail reconciliation durably disables stale Nango credentials', async () => {
  const updates = [];
  const warnings = [];
  const connection = {
    id: 'connection-1',
    userId: 'user-1',
    orgId: 'org-1',
    providerKey: 'gmail',
    status: 'active',
    metadata: { gmail_watcher: { history_id: '123' } },
  };
  const prisma = {
    nangoConnection: {
      findMany: async () => [connection],
      updateMany: async (input) => { updates.push(input); return { count: 1 }; },
    },
  };

  const result = await reconcileAllGmailWatches({
    prisma,
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
    reconcile: async () => { throw new Error('Nango GET /connection/x 401: unknown_account'); },
  });

  assert.deepEqual(result, { checked: 1, reconciled: 0, failed: 0, disabled: 1 });
  assert.equal(updates[0].data.status, 'error');
  assert.equal(updates[0].data.metadata.gmail_watcher.disabled_reason, 'credentials_invalid_reconnect_required');
  assert.match(warnings[0], /disabled stale connection connection-1/);
});

test('scheduled Gmail reconciliation keeps transient failures active and observable', async () => {
  let updated = false;
  const prisma = {
    nangoConnection: {
      findMany: async () => [{ id: 'connection-2', orgId: 'org-2', status: 'active' }],
      updateMany: async () => { updated = true; return { count: 1 }; },
    },
  };

  const result = await reconcileAllGmailWatches({
    prisma,
    logger: { warn: () => {} },
    reconcile: async () => { throw new Error('temporary Gmail 503'); },
  });

  assert.deepEqual(result, { checked: 1, reconciled: 0, failed: 1, disabled: 0 });
  assert.equal(updated, false);
});
