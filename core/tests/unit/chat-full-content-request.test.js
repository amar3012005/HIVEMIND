import test from 'node:test';
import assert from 'node:assert/strict';
import { gatherEvidence } from '../../src/agent/react-agent-v2.js';

test('chat recall requests full authorized rows for answer evidence projection', async () => {
  const calls = [];
  const ctx = {
    userId: 'user-1',
    orgId: 'org-1',
    _toolkit: {
      hasTool: (name) => name === 'hivemind_recall',
      async execute(name, args) {
        calls.push({ name, args });
        return {
          status: 'ok',
          content: [],
          meta: { raw: { memories: [{ id: 'm1', content: 'complete row' }], evidence: [] } },
        };
      },
    },
  };

  await gatherEvidence({
    plan: {
      operation: 'recall',
      user_message: 'small detail',
      query_canonical_en: 'small detail',
      sub_queries: [],
      named_entities: [],
      recall_mode: 'quick',
      tool_groups: [],
    },
    ctx,
    deadlineAt: Date.now() + 10_000,
  });

  assert.equal(calls[0].args._include_full_memory_content, true);
  assert.equal(calls[0].args.semantic_recovery, true);
  assert.equal(calls[0].args.entity_filter_mode, 'should');
});
