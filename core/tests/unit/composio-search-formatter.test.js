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
  assert.equal(payload.queries[0].known_fields, 'destination_apps:gmail;recipient_name:rama;intent:send_message');
  assert.equal(payload.queries[0].use_case, 'The user wants to send the company information to a person called rama');
  assert.equal(Object.keys(payload.queries[0]).sort().join(','), 'known_fields,use_case');
});

test('read lookups ask for list/get-my tools and name the destination app', () => {
  const payload = formatComposioSearch({
    message: 'what was my last linkedin post about?',
    destinationApps: ['linkedin'],
  });
  assert.equal(Object.keys(payload.queries[0]).sort().join(','), 'known_fields,use_case');
  assert.equal(payload.queries[0].known_fields, 'destination_apps:linkedin;intent:read_existing;scope:authenticated_user');
  assert.match(payload.queries[0].use_case, /linkedin/i);
  assert.match(payload.queries[0].use_case, /list, get-my, or recent/i);
  assert.match(payload.queries[0].use_case, /Do not create, send, or publish/i);
  assert.equal(/create a post/i.test(payload.queries[0].use_case), false);
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
