import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractWorkflowSessionId,
  formatComposioSearch,
} from '../../src/connectors/composio/composio-search-formatter.js';

test('Composio search formatter matches the legal COMPOSIO_SEARCH_TOOLS schema', () => {
  const payload = formatComposioSearch({
    message: 'the user wants to send the company information to a person called rama',
    sessionId: 'trs_123',
    destinationApps: ['gmail'],
  });
  assert.equal(payload.session.generate_id, true);
  assert.equal(payload.session.id, undefined);
  assert.equal(payload.search_strategy, 'auto');
  assert.equal(payload.queries[0].search_strategy, undefined);
  assert.equal(payload.queries[0].destination_app, undefined);
  assert.equal(typeof payload.queries[0].known_fields, 'string');
  assert.match(payload.queries[0].known_fields, /recipient_name:rama/i);
  assert.match(payload.queries[0].known_fields, /destination_apps:gmail/);
  assert.match(payload.queries[0].known_fields, /HIVEMIND is the company brain/);
  assert.match(payload.queries[0].use_case, /company brain/i);
  assert.match(payload.queries[0].use_case, /Draft only/i);
  assert.equal(Object.keys(payload.queries[0]).sort().join(','), 'known_fields,use_case');
});

test('later searches reuse the workflow word, never a Tool Router id', () => {
  const payload = formatComposioSearch({
    message: 'continue',
    sessionId: 'nice',
    generateId: false,
    searchStrategy: 'tool_search',
  });
  assert.deepEqual(payload.session, { id: 'nice' });
  assert.equal(payload.search_strategy, 'tool_search');
  assert.equal(extractWorkflowSessionId({ data: { session: { id: 'nice' } } }), 'nice');
  assert.equal(extractWorkflowSessionId({ data: { session: { id: 'trs_abc' } } }), null);
});
