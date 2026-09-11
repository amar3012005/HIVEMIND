import test from 'node:test';
import assert from 'node:assert/strict';

import { composioConnectionSubject } from '../../src/connectors/composio/composio-service.js';

test('Composio personal connections use the authenticated HIVE user subject', () => {
  assert.equal(
    composioConnectionSubject('org-a', { userId: 'user-a' }),
    'hivemind:user-a',
  );
});

test('legacy organization scope remains explicit for migration reads', () => {
  assert.equal(composioConnectionSubject('org-a'), 'org-a');
});
