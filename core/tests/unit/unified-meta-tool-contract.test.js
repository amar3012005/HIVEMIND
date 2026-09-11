import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compactConnectedSearch,
  connectedToolAuthority,
  disconnectedToolkits,
  parseUnifiedToolCall,
  selectedToolSlugs,
  unifiedMetaTools,
} from '../../src/agent/unified-meta-tool-contract.js';

test('use_tools is only a capability latch over two stable meta tools', () => {
  assert.deepEqual(unifiedMetaTools({ useTools: false }).map(row => row.function.name), ['hivemind_meta']);
  assert.deepEqual(unifiedMetaTools({ useTools: true }).map(row => row.function.name), ['hivemind_meta', 'hivemind_connected_task']);
  assert.equal(JSON.stringify(unifiedMetaTools({ useTools: true })).includes('GMAIL_FETCH_EMAILS'), false);
});

test('connected search projection preserves plans, connection state, and selected slugs without provider schemas', () => {
  const raw = { data: {
    session: { id: 'workflow-1' },
    results: [{
      use_case: 'Fetch five newest unread Gmail messages with subject sender and timestamp',
      primary_tool_slugs: ['GMAIL_FETCH_EMAILS'], related_tool_slugs: ['GMAIL_LIST_THREADS'],
      recommended_plan_steps: ['Fetch messages', 'Present requested fields'], known_pitfalls: ['Use unread filter'],
    }],
    toolkit_connection_statuses: [{ toolkit: 'gmail', has_active_connection: false }],
    next_steps_guidance: ['Connect Gmail before execution'],
  } };
  const compact = compactConnectedSearch(raw);
  assert.deepEqual(selectedToolSlugs(raw), ['GMAIL_FETCH_EMAILS', 'GMAIL_LIST_THREADS']);
  assert.deepEqual(disconnectedToolkits(compact.toolkit_connection_statuses), ['gmail']);
  assert.equal(JSON.stringify(compact).includes('input_schema'), false);
  assert.equal(compact.results[0].recommended_plan_steps[0], 'Fetch messages');
});

test('tool-call parsing and authority validation remain server owned', () => {
  assert.deepEqual(parseUnifiedToolCall({ id: 'c1', function: { name: 'hivemind_meta', arguments: '{"operation":"context"}' } }), {
    id: 'c1', name: 'hivemind_meta', args: { operation: 'context' },
  });
  assert.throws(() => parseUnifiedToolCall({ function: { name: 'GMAIL_FETCH_EMAILS', arguments: '{}' } }), /not_allowed/);
  assert.equal(connectedToolAuthority('GMAIL_GET_POST_CONTENT'), 'read');
  assert.equal(connectedToolAuthority('GMAIL_SEND_EMAIL'), 'write');
  assert.equal(connectedToolAuthority('ODD_PROVIDER_ACTION', { read_only: true }), 'read');
});
