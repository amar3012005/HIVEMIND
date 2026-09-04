import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatComposioSearch } from '../../src/connectors/composio/composio-search-formatter.js';

test('Composio search formatter carries a bounded goal, destination, and known recipient', () => {
  const payload = formatComposioSearch({
    message: 'Write a quick reply to Rama in Gmail about the approved proposal.',
    sessionId: 'trs_123',
    destinationApps: ['gmail'],
  });
  assert.equal(payload.session.id, 'trs_123');
  assert.equal(payload.session.generate_id, 'trs_123');
  assert.equal(payload.queries[0].search_strategy, 'auto');
  assert.equal(payload.queries[0].destination_app, 'gmail');
  assert.equal(payload.queries[0].known_fields.recipient_name, 'Rama');
  assert.deepEqual(payload.queries[0].known_fields.destination_apps, ['gmail']);
  assert.match(payload.queries[0].known_fields.product_context, /HIVEMIND/);
});
