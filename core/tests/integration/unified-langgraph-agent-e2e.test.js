import test from 'node:test';
import assert from 'node:assert/strict';
import { MemorySaver } from '@langchain/langgraph';

import { runUnifiedMetaAgent, UNIFIED_META_HARNESS_VERSION } from '../../src/agent/unified-langgraph-agent.js';

const ORG = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';

function call(name, args, id) {
  return { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}

function fakePrisma() {
  const drafts = [];
  return {
    drafts,
    pendingWrite: {
      async findFirst({ where }) {
        return drafts.find(row => (where.id ? row.id === where.id : row.idempotencyKey === where.idempotencyKey)
          && (!where.orgId || row.orgId === where.orgId) && (!where.userId || row.userId === where.userId)) || null;
      },
      async create({ data }) { const row = { id: `draft-${drafts.length + 1}`, ...data }; drafts.push(row); return row; },
      async updateMany({ where, data }) {
        const rows = drafts.filter(row => Object.entries(where).every(([key, value]) => {
          if (key === 'expiresAt') return row.expiresAt > value.gt;
          return row[key] === value;
        }));
        rows.forEach(row => Object.assign(row, data)); return { count: rows.length };
      },
      async update({ where, data }) { const row = drafts.find(item => item.id === where.id); Object.assign(row, data); return row; },
    },
  };
}

function ctx(prisma, suffix, language = 'en') {
  return { orgId: ORG, userId: USER, prisma, language, threadId: `thread-${suffix}`, unifiedGraphThreadId: `unified-${suffix}`, model: 'test' };
}

function saveCapabilityDecision(input) {
  assert.equal(input.stage, 'capability');
  return {
    status: 'selected', selected: 'hivemind_save', authoritative: true,
    receipt: { source: 'jev', probability: 0.99, margin: 0.97, requestId: 'save-capability-plan' },
  };
}

function richSaveToolCall(id = 'rich-save') {
  return {
    message: call('hivemind_meta', { operation: 'save', save: {
      title: 'Rama Santhoshi — relationship and Prague anniversary invitation',
      content: 'Rama Santhoshi is supported by the prior conversation as Amar\'s partner and accepted the Prague anniversary invitation on September 14, 2026. The source is the preceding assistant answer; no unsupported details are asserted.',
      source_type: 'conversation',
      tags: ['person:rama-santhoshi', 'place:prague', 'event:anniversary-invitation'],
      entities: ['Rama Santhoshi', 'Amar', 'Prague'],
      dates: ['2026-09-14'],
      source_refs: ['conversation:prior-assistant-answer'],
    } }, id),
  };
}

test('one model-tool graph handles native recall and final synthesis with only hivemind_meta', async () => {
  const prisma = fakePrisma();
  const seenTools = [];
  let turn = 0;
  const modelStep = async ({ tools }) => {
    seenTools.push(tools.map(row => row.function.name));
    turn += 1;
    if (turn === 1) return { message: call('hivemind_meta', { operation: 'recall', recall: { query: 'Was wissen wir über Rama?', mode: 'fact', limit: 5 } }, 'm1') };
    return { message: { role: 'assistant', content: 'Wir wissen aus den gespeicherten Quellen, dass Rama am Singulance-Projekt beteiligt ist.' } };
  };
  const result = await runUnifiedMetaAgent({
    message: 'Was wissen wir über Rama?', useTools: false, prisma, ctx: ctx(prisma, 'native', 'de'), checkpointer: new MemorySaver(), modelStep,
    metaExecutor: async () => ({ successful: true, data: { memories: [{ title: 'Rama and Singulance', content: 'Rama is involved in the Singulance project.' }] } }),
    composio: {},
  });
  assert.equal(result.status, 'completed');
  assert.match(result.response, /Rama/);
  assert.deepEqual(seenTools, [['hivemind_meta'], []]);
  assert.equal(result.run.scratch.harness_version, UNIFIED_META_HARNESS_VERSION);
});

test('native HIVE recall streams its final answer from governed read receipts', async () => {
  const prisma = fakePrisma();
  const events = [];
  let turn = 0;
  const result = await runUnifiedMetaAgent({
    message: 'What have I been working on lately?', useTools: false, prisma, ctx: ctx(prisma, 'recall-stream'), checkpointer: new MemorySaver(),
    onEvent: event => events.push(event), composio: {},
    modelStep: async () => {
      turn += 1;
      if (turn === 1) return { message: call('hivemind_meta', { operation: 'recall', recall: { query: 'recent work', limit: 3 } }, 'mr1') };
      throw new Error('verified native-read synthesis must stream without a second buffered model call');
    },
    finalStream: async ({ messages, onDelta }) => {
      assert.deepEqual(messages.map(row => row.role), ['system', 'user', 'system']);
      assert.match(messages[0].content, /organization's living memory/i);
      assert.match(messages[0].content, /generic chatbox/i);
      await onDelta('You have been ');
      await onDelta('working on durable chat.');
      return { ok: true, content: 'You have been working on durable chat.', usage: { total_tokens: 9 } };
    },
    metaExecutor: async () => ({ successful: true, data: { memories: [{ title: 'Durable chat', content: 'Streaming and LangGraph work.' }] } }),
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.response, 'You have been working on durable chat.');
  assert.deepEqual(events.filter(event => event.type === 'answer_delta').map(event => event.delta), ['You have been ', 'working on durable chat.']);
  assert.equal(result.usage.at(-1).total_tokens, 9);
});

test('a JEV context decision exposes the authenticated HIVE context executor before streaming', async () => {
  const prisma = fakePrisma();
  const seenTools = [];
  const events = [];
  const result = await runUnifiedMetaAgent({
    message: 'What do you know about me?', useTools: false, prisma, ctx: ctx(prisma, 'jev-context'), checkpointer: new MemorySaver(), composio: {},
    onEvent: event => events.push(event),
    decisionStage: async input => {
      assert.equal(input.stage, 'capability');
      return {
        status: 'selected', selected: 'hivemind_context', authoritative: true,
        receipt: { source: 'jev', probability: 0.99, margin: 0.97, requestId: 'context-plan' },
      };
    },
    modelStep: async ({ tools }) => {
      seenTools.push(tools.map(tool => tool.function.name));
      assert.deepEqual(tools.map(tool => tool.function.name), ['hivemind_meta']);
      return { message: call('hivemind_meta', { operation: 'context' }, 'context-1') };
    },
    metaExecutor: async args => {
      assert.equal(args.operation, 'context');
      return { successful: true, data: { profile_context: 'Name: Aster Helius\nOrganization: SINGULANCE\nLocation: Hannover' } };
    },
    finalStream: async ({ messages, onDelta }) => {
      assert.match(messages.at(-1).content, /Aster Helius/);
      await onDelta('You are Aster Helius at SINGULANCE.');
      return { ok: true, content: 'You are Aster Helius at SINGULANCE.' };
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.response, 'You are Aster Helius at SINGULANCE.');
  assert.deepEqual(seenTools, [['hivemind_meta']]);
  assert.ok(events.some(event => event.type === 'answer_delta'));
});

test('JEV entity intent performs the fast governed canonical lookup before streaming', async () => {
  const prisma = fakePrisma();
  const events = [];
  let lookup = null;
  const result = await runUnifiedMetaAgent({
    message: 'Who is Rama?', useTools: false, prisma, ctx: {
      ...ctx(prisma, 'entity-fast'),
      _tracedDispatch: async (slug, args) => {
        lookup = { slug, args };
        return { matches: [{ id: 'entity-rama', canonicalName: 'Rama Santhoshi', aliases: ['Rama'] }], degradation: null };
      },
    }, checkpointer: new MemorySaver(), composio: {}, onEvent: event => events.push(event),
    decisionStage: async input => ({ status: 'selected', selected: 'hivemind_entity_lookup', authoritative: true,
      receipt: { source: 'jev', probability: 0.98, margin: 0.94, requestId: 'entity-plan' } }),
    modelStep: async ({ tools }) => {
      assert.deepEqual(tools.map(tool => tool.function.name), ['hivemind_meta']);
      return { message: call('hivemind_meta', { operation: 'entities', entity: { query: 'Rama' } }, 'entity-1') };
    },
    finalStream: async ({ messages, onDelta }) => {
      assert.match(messages.at(-1).content, /Rama Santhoshi/);
      await onDelta('I found Rama Santhoshi as the canonical match for Rama.');
      return { ok: true, content: 'I found Rama Santhoshi as the canonical match for Rama.' };
    },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(lookup, { slug: 'hivemind_find_entities', args: { query: 'Rama', entity_types: [], limit: 12 } });
  assert.ok(events.some(event => event.type === 'answer_delta'));
});

test('LangGraph follow-up chips are source-grounded and omitted for mutations', async () => {
  const prisma = fakePrisma();
  const runRecall = async suffix => runUnifiedMetaAgent({
    message: 'What do we know about the launch?', useTools: false, prisma, ctx: ctx(prisma, suffix), checkpointer: new MemorySaver(), composio: {},
    decisionStage: async () => ({ status: 'selected', selected: 'hivemind_memory_lookup', authoritative: true,
      receipt: { source: 'jev', probability: 0.99, margin: 0.95 } }),
    modelStep: async () => ({ message: call('hivemind_meta', { operation: 'recall', recall: { query: 'launch' } }, `recall-${suffix}`) }),
    metaExecutor: async () => ({ successful: true, data: { memories: [{ id: 'm-launch', title: 'Project Northstar launch decision', content: 'The team chose a staged launch.' }] } }),
    finalStream: async ({ onDelta }) => {
      await onDelta('The team chose a staged launch for Project Northstar.');
      return { ok: true, content: 'The team chose a staged launch for Project Northstar.' };
    },
  });
  const recalled = await runRecall('followup-read');
  assert.deepEqual(recalled.followUps, ['What else does Project Northstar launch decision say about this topic?']);

  const saved = await runUnifiedMetaAgent({
    message: 'Remember that I prefer short updates.', useTools: false, prisma, ctx: ctx(prisma, 'followup-save'), checkpointer: new MemorySaver(), composio: {},
    decisionStage: async input => input.stage === 'capability'
      ? { status: 'selected', selected: 'hivemind_save', authoritative: true, receipt: { source: 'jev', probability: 0.99, margin: 0.95 } }
      : { status: 'selected', selected: 'preference', authoritative: true, receipt: { source: 'jev', probability: 0.99, margin: 0.95 } },
    modelStep: async () => ({ message: call('hivemind_meta', { operation: 'save', save: {
      title: 'Aster prefers concise updates', content: 'Aster states a preference for short updates.', memory_type: 'preference',
      tags: ['aster', 'communication-preference'], entities: ['Aster'], source_refs: ['conversation:current'], scope: 'personal',
    } }, 'save-followup') }),
    metaExecutor: async () => ({ successful: true, data: { saved: true, title: 'Aster prefers concise updates', scope: 'personal' } }),
  });
  assert.equal(saved.followUps.length, 0);
});

test('a multi-task receipt uses JEV to continue into one grounded memory save before sealing', async () => {
  const prisma = fakePrisma();
  const decisionStages = [];
  const seenTools = [];
  let turn = 0;
  const result = await runUnifiedMetaAgent({
    message: 'Get all information from HIVE-MIND about Rama and save it as one memory.',
    useTools: false, prisma, ctx: ctx(prisma, 'multi-recall-save'), checkpointer: new MemorySaver(), composio: {},
    decisionStage: async input => {
      decisionStages.push(input.stage);
      if (input.stage === 'capability') {
        return { status: 'selected', selected: 'multi_task', authoritative: true,
          receipt: { source: 'jev', probability: 0.99, margin: 0.97, requestId: 'multi-plan' } };
      }
      if (input.stage === 'memory_type') {
        return { status: 'selected', selected: 'fact', authoritative: true,
          receipt: { source: 'jev', probability: 0.98, margin: 0.95, requestId: 'multi-memory-type' } };
      }
      assert.equal(input.stage, 'workflow_transition');
      assert.equal(input.context.workflow.phase, 'post_receipt');
      if (input.observation.completed_receipts.at(-1).action === 'recall') {
        return { status: 'selected', selected: 'hivemind_save', authoritative: true,
          receipt: { source: 'jev', probability: 0.98, margin: 0.95, requestId: 'multi-save' } };
      }
      assert.equal(input.observation.completed_receipts.at(-1).action, 'save');
      return { status: 'selected', selected: 'synthesize', authoritative: true,
        receipt: { source: 'jev', probability: 0.99, margin: 0.98, requestId: 'multi-seal' } };
    },
    modelStep: async ({ tools }) => {
      seenTools.push(tools.map(tool => tool.function.name));
      turn += 1;
      if (turn === 1) return { message: call('hivemind_meta', { operation: 'recall', recall: { query: 'Rama', mode: 'fact', limit: 10 } }, 'multi-1') };
      if (turn === 2) {
        assert.deepEqual(tools.map(tool => tool.function.name), ['hivemind_meta']);
        return { message: call('hivemind_meta', { operation: 'save', save: {
          title: 'Rama Santhoshi: retrieved relationship and correspondence',
          content: 'Rama Santhoshi is supported by retrieved HIVE memories about correspondence and a Prague event.',
          tags: ['rama-santhoshi', 'retrieved'], entities: ['Rama Santhoshi'], dates: ['2026-09-14'], source_refs: ['memory:rama-1'],
        } }, 'multi-2') };
      }
      assert.deepEqual(tools.map(tool => tool.function.name), []);
      return { message: { role: 'assistant', content: 'Rama Santhoshi was saved from the governed HIVE evidence.' } };
    },
    metaExecutor: async args => (args.operation === 'recall'
      ? { successful: true, data: { memories: [{ id: 'rama-1', title: 'Rama correspondence', content: 'Prague event on 2026-09-14.' }] } }
      : { successful: true, data: { saved: true, title: args.save.title, scope: 'personal', memory_id: 'saved-rama-1' } }),
  });
  assert.equal(result.status, 'completed');
  assert.match(result.response, /Rama Santhoshi/);
  assert.deepEqual(decisionStages, ['capability', 'workflow_transition', 'memory_type', 'workflow_transition']);
  assert.deepEqual(seenTools, [['hivemind_meta'], ['hivemind_meta'], []]);
  assert.ok(result.steps.some(step => step.summary === 'Memory saved'));
});

test('a multi-task scope save returns to JEV and reaches the remaining governed action', async () => {
  const prisma = fakePrisma();
  const checkpointer = new MemorySaver();
  const stages = [];
  let turn = 0;
  const runtimeCtx = {
    ...ctx(prisma, 'read-save-send'),
    _tracedDispatch: async (name, args) => {
      assert.equal(name, 'hivemind_save_memory');
      assert.equal(args.scope, 'personal');
      return { saved: true, memory_id: 'saved-1', title: args.title, scope: args.scope };
    },
  };
  const decisionStage = async input => {
    stages.push(input.stage);
    if (input.stage === 'capability') return {
      status: 'selected', selected: 'multi_task', authoritative: true,
      receipt: { source: 'jev', probability: 0.99, margin: 0.97, requestId: 'plan' },
    };
    if (input.stage === 'memory_type') return {
      status: 'selected', selected: 'fact', authoritative: true,
      receipt: { source: 'jev', probability: 0.98, margin: 0.95, requestId: 'memory-type' },
    };
    const action = input.observation.completed_receipts.at(-1).action;
    const selected = action === 'save' ? 'composio_action' : 'hivemind_save';
    return {
      status: 'selected', selected, authoritative: true,
      receipt: { source: 'jev', probability: 0.98, margin: 0.95, requestId: `transition-${action}` },
    };
  };
  const modelStep = async ({ tools }) => {
    turn += 1;
    if (turn === 1) return { message: call('hivemind_connected_task', {
      action: 'execute', tool_slug: 'SOURCE_READ', arguments: { query: 'latest records' },
    }, 'read-1') };
    if (turn === 2) return { message: call('hivemind_meta', { operation: 'save', save: {
      title: 'Retrieved records', content: 'Grounded records from the completed source read.', tags: ['retrieved', 'user-confirmed'],
    } }, 'save-1') };
    assert.deepEqual(tools.map(tool => tool.function.name), ['hivemind_connected_task']);
    return { message: call('hivemind_connected_task', {
      action: 'execute', tool_slug: 'MESSAGE_SEND', arguments: { recipient: 'person@example.test', body: 'A follow-up based on the retrieved records.' },
    }, 'send-1') };
  };
  const connectedExecutor = async args => {
    if (args.tool_slug === 'SOURCE_READ') return {
      successful: true,
      data: { records: [{ id: 'record-1', subject: 'Source evidence' }] },
      state: { selectedSlugs: ['SOURCE_READ'], primarySlugs: ['SOURCE_READ'] },
    };
    assert.equal(args.tool_slug, 'MESSAGE_SEND');
    return {
      successful: true,
      approval: {
        slug: 'MESSAGE_SEND',
        arguments: args.arguments,
        schema: { type: 'object', required: ['recipient', 'body'], properties: { recipient: { type: 'string' }, body: { type: 'string' } } },
      },
    };
  };
  const first = await runUnifiedMetaAgent({
    message: 'Read source records, save them to HIVE-MIND, and send a follow-up.',
    useTools: true, prisma, ctx: runtimeCtx, checkpointer, composio: {}, decisionStage, modelStep, connectedExecutor,
    metaExecutor: async args => ({ successful: true, data: { needs_project_choice: true, title: args.save.title, scopes: [{ scope: 'personal', label: 'Personal' }] } }),
  });
  assert.equal(first.status, 'needs_input');
  const resumed = await runUnifiedMetaAgent({
    message: '', useTools: true, prisma,
    ctx: { ...runtimeCtx, unifiedRunId: first.run.id }, checkpointer, composio: {}, decisionStage, modelStep, connectedExecutor,
    choice: { scope: 'personal', run_id: first.run.id },
  });
  assert.equal(resumed.status, 'pending');
  assert.equal(prisma.drafts[0].toolName, 'MESSAGE_SEND');
  assert.deepEqual(stages, ['capability', 'workflow_transition', 'memory_type', 'workflow_transition']);
  assert.equal(turn, 3);
});

test('a scoped compound write resumes its remaining action even when the initial decision fell back', async () => {
  const prisma = fakePrisma();
  const checkpointer = new MemorySaver();
  const stages = [];
  let turn = 0;
  const runtimeCtx = {
    ...ctx(prisma, 'fallback-read-save-send'),
    _tracedDispatch: async (name, args) => ({ saved: name === 'hivemind_save_memory', memory_id: 'saved-fallback', title: args.title, scope: args.scope }),
  };
  const decisionStage = async input => {
    stages.push(input.stage);
    if (input.stage === 'capability') return {
      status: 'defer', selected: null, authoritative: false,
      receipt: { source: 'fallback', reason: 'decision_state_exceeds_budget' },
    };
    if (input.stage === 'memory_type') return {
      status: 'selected', selected: 'fact', authoritative: true,
      receipt: { source: 'jev', probability: 0.98, margin: 0.95, requestId: 'memory-type' },
    };
    return {
      status: 'selected', selected: 'composio_action', authoritative: true,
      receipt: { source: 'jev', probability: 0.98, margin: 0.95, requestId: 'resume-action' },
    };
  };
  const modelStep = async () => {
    turn += 1;
    if (turn === 1) return { message: call('hivemind_connected_task', { action: 'execute', tool_slug: 'SOURCE_READ', arguments: { query: 'latest records' } }, 'fallback-read') };
    if (turn === 2) return { message: call('hivemind_meta', { operation: 'save', save: { title: 'Retrieved records', content: 'Grounded evidence.', tags: ['retrieved'] } }, 'fallback-save') };
    return { message: call('hivemind_connected_task', { action: 'execute', tool_slug: 'MESSAGE_SEND', arguments: { recipient: 'person@example.test', body: 'Follow-up.' } }, 'fallback-send') };
  };
  const connectedExecutor = async args => args.tool_slug === 'SOURCE_READ'
    ? { successful: true, data: { records: [{ id: 'record-1' }] }, state: { selectedSlugs: ['SOURCE_READ'], primarySlugs: ['SOURCE_READ'] } }
    : { successful: true, approval: { slug: 'MESSAGE_SEND', arguments: args.arguments, schema: { type: 'object', required: ['recipient', 'body'], properties: { recipient: { type: 'string' }, body: { type: 'string' } } } } };
  const first = await runUnifiedMetaAgent({
    message: 'Read source records, save them to HIVE-MIND, and send a follow-up.', useTools: true, prisma,
    ctx: runtimeCtx, checkpointer, composio: {}, decisionStage, modelStep, connectedExecutor,
    metaExecutor: async args => ({ successful: true, data: { needs_project_choice: true, title: args.save.title, scopes: [{ scope: 'personal', label: 'Personal' }] } }),
  });
  assert.equal(first.status, 'needs_input');
  const resumed = await runUnifiedMetaAgent({
    message: '', useTools: true, prisma, ctx: { ...runtimeCtx, unifiedRunId: first.run.id }, checkpointer, composio: {}, decisionStage, modelStep, connectedExecutor,
    choice: { scope: 'personal', run_id: first.run.id },
  });
  assert.equal(resumed.status, 'pending');
  assert.equal(prisma.drafts[0].toolName, 'MESSAGE_SEND');
  assert.deepEqual(stages, ['capability', 'memory_type', 'workflow_transition']);
});

test('a timed-out scoped compound save preserves its checkpoint and resumes the remaining action after one retry', async () => {
  const prisma = fakePrisma();
  const checkpointer = new MemorySaver();
  let saves = 0;
  let turn = 0;
  const runtimeCtx = {
    ...ctx(prisma, 'retryable-scope-save'),
    _tracedDispatch: async (name, args) => {
      assert.equal(name, 'hivemind_save_memory');
      assert.equal(args.scope, 'organization');
      assert.match(args._source_id, /^unified-memory-save:/);
      saves += 1;
      if (saves === 1) throw new Error('tool:hivemind_save_memory deadline exceeded');
      return { saved: true, memory_id: 'saved-after-retry', title: args.title, scope: args.scope };
    },
  };
  const decisionStage = async input => input.stage === 'capability'
    ? { status: 'selected', selected: 'multi_task', authoritative: true, receipt: { source: 'jev', probability: 0.99, margin: 0.97, requestId: 'retry-plan' } }
    : { status: 'selected', selected: 'composio_action', authoritative: true, receipt: { source: 'jev', probability: 0.98, margin: 0.95, requestId: 'retry-transition' } };
  const modelStep = async () => {
    turn += 1;
    if (turn === 1) return { message: call('hivemind_connected_task', { action: 'execute', tool_slug: 'SOURCE_READ', arguments: { query: 'latest records' } }, 'retry-read') };
    if (turn === 2) return { message: call('hivemind_meta', { operation: 'save', save: { title: 'Retrieved records', content: 'Grounded source records.', tags: ['retrieved', 'user-confirmed'] } }, 'retry-save') };
    return { message: call('hivemind_connected_task', { action: 'execute', tool_slug: 'MESSAGE_SEND', arguments: { recipient: 'person@example.test', body: 'Follow-up.' } }, 'retry-send') };
  };
  const connectedExecutor = async args => args.tool_slug === 'SOURCE_READ'
    ? { successful: true, data: { records: [{ id: 'record-1' }] }, state: { selectedSlugs: ['SOURCE_READ'], primarySlugs: ['SOURCE_READ'] } }
    : { successful: true, approval: { slug: 'MESSAGE_SEND', arguments: args.arguments, schema: { type: 'object', required: ['recipient', 'body'], properties: { recipient: { type: 'string' }, body: { type: 'string' } } } } };
  const metaExecutor = async args => ({ successful: true, data: { needs_project_choice: true, title: args.save.title, scopes: [{ scope: 'organization', label: 'Organization' }] } });

  const scoped = await runUnifiedMetaAgent({
    message: 'Read source records, save them to HIVE-MIND, and send a follow-up.', useTools: true, prisma, ctx: runtimeCtx,
    checkpointer, composio: {}, decisionStage, modelStep, connectedExecutor, metaExecutor,
  });
  assert.equal(scoped.status, 'needs_input');
  const retryPrompt = await runUnifiedMetaAgent({
    message: '', useTools: true, prisma, ctx: { ...runtimeCtx, unifiedRunId: scoped.run.id }, checkpointer, composio: {}, decisionStage, modelStep, connectedExecutor, metaExecutor,
    choice: { scope: 'organization', run_id: scoped.run.id },
  });
  assert.equal(retryPrompt.status, 'needs_input');
  assert.equal(retryPrompt.inputRequests[0].kind, 'memory_save_retry');
  assert.equal(retryPrompt.inputRequests[0].selected_scope, 'organization');
  const resumed = await runUnifiedMetaAgent({
    message: '', useTools: true, prisma, ctx: { ...runtimeCtx, unifiedRunId: scoped.run.id }, checkpointer, composio: {}, decisionStage, modelStep, connectedExecutor, metaExecutor,
    choice: { action: 'retry', run_id: scoped.run.id },
  });
  assert.equal(resumed.status, 'pending');
  assert.equal(prisma.drafts[0].toolName, 'MESSAGE_SEND');
  assert.equal(saves, 2);
  assert.ok(resumed.steps.some(step => step.summary === 'Memory saved in selected scope'));
});

test('the in-graph plan node calls JEV once and reuses its typed decision for the model surface', async () => {
  const prisma = fakePrisma();
  const decisionStages = [];
  const seenTools = [];
  const events = [];
  const result = await runUnifiedMetaAgent({
    message: 'Hello, who are you?', useTools: false, prisma, ctx: ctx(prisma, 'plan-node'), checkpointer: new MemorySaver(), composio: {},
    onEvent: event => events.push(event),
    decisionStage: async input => {
      decisionStages.push(input.stage);
      return { status: 'selected', selected: 'direct_answer', authoritative: true,
        receipt: { source: 'jev', probability: 0.98, margin: 0.94, requestId: 'plan-decision-1' } };
    },
    modelStep: async ({ tools }) => {
      seenTools.push(tools.map(tool => tool.function.name));
      return { message: { role: 'assistant', content: 'I am HIVE-MIND.' } };
    },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(decisionStages, ['capability']);
  assert.deepEqual(seenTools, [[]]);
  assert.deepEqual(result.run.scratch.plan, {
    intent: 'direct_answer', source: 'jev', authoritative: true, probability: 0.98, margin: 0.94,
    reason: null, diagnostics: null,
  });
  assert.ok(events.some(event => event.type === 'decision' && event.stage === 'capability'
    && event.selected === 'direct_answer' && event.source === 'jev'));
});

test('an authoritative JEV direct-answer decision streams without buffered re-planning', async () => {
  const prisma = fakePrisma();
  const events = [];
  const result = await runUnifiedMetaAgent({
    message: 'Who are you?', useTools: false, prisma, ctx: ctx(prisma, 'direct-answer-stream'), checkpointer: new MemorySaver(), composio: {},
    onEvent: event => events.push(event),
    decisionStage: async () => ({
      status: 'selected', selected: 'direct_answer', authoritative: true,
      receipt: { source: 'jev', probability: 0.98, margin: 0.94, requestId: 'direct-stream-plan' },
    }),
    modelStep: async () => { throw new Error('direct-answer must not enter buffered model planning'); },
    finalStream: async ({ messages, onDelta }) => {
      assert.equal(messages.at(-1).role, 'system');
      assert.match(messages.at(-1).content, /Answer directly from the supplied context/);
      assert.match(messages[0].content, /trusted colleague/i);
      assert.match(messages[0].content, /generic capability menu/i);
      await onDelta('I am ');
      await onDelta('HIVE-MIND.');
      return { ok: true, content: 'I am HIVE-MIND.', usage: { total_tokens: 4 } };
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.response, 'I am HIVE-MIND.');
  assert.deepEqual(events.filter(event => event.type === 'answer_delta').map(event => event.delta), ['I am ', 'HIVE-MIND.']);
  assert.equal(result.run.scratch.plan.intent, 'direct_answer');
});

test('a deferred JEV plan persists and renders its safe fallback diagnostic', async () => {
  const prisma = fakePrisma();
  const events = [];
  const result = await runUnifiedMetaAgent({
    message: 'What do you know about me?', useTools: false, prisma, ctx: ctx(prisma, 'fallback-diagnostic'), checkpointer: new MemorySaver(), composio: {},
    onEvent: event => events.push(event),
    decisionStage: async () => ({
      status: 'defer', selected: null, authoritative: false,
      receipt: { source: 'fallback', reason: 'decision_probability_below_threshold', diagnostics: { choice: 'hivemind_memory_lookup', probability: 0.46, margin: 0.03 } },
    }),
    modelStep: async ({ tools }) => {
      assert.deepEqual(tools, []);
      return { message: { role: 'assistant', content: 'I need a clearer route.' } };
    },
  });
  assert.equal(result.run.scratch.plan.reason, 'decision_probability_below_threshold');
  assert.deepEqual(result.run.scratch.plan.diagnostics, { choice: 'hivemind_memory_lookup', probability: 0.46, margin: 0.03 });
  const decision = events.find(event => event.type === 'decision' && event.stage === 'capability');
  assert.equal(decision.selected, null);
  assert.equal(decision.reason, 'decision_probability_below_threshold');
  assert.deepEqual(decision.diagnostics, { choice: 'hivemind_memory_lookup', probability: 0.46, margin: 0.03 });
});

test('a JEV multi-task plan completes HIVE retrieval before its dependent memory save', async () => {
  const prisma = fakePrisma();
  const operations = [];
  let turn = 0;
  const result = await runUnifiedMetaAgent({
    message: 'Get all information from HIVE-MIND about Rama and save it as one memory.',
    useTools: false, prisma, ctx: ctx(prisma, 'multi-read-save'), checkpointer: new MemorySaver(), composio: {},
    decisionStage: async input => ({
      status: 'selected', selected: input.stage === 'capability' ? 'multi_task'
        : input.observation.completed_receipts.at(-1).action === 'recall' ? 'hivemind_save' : 'synthesize',
      authoritative: true,
      receipt: { source: 'jev', probability: 0.99, margin: 0.98, requestId: `multi-read-save-${input.stage}` },
    }),
    modelStep: async ({ messages }) => {
      turn += 1;
      if (turn === 1) {
        assert.match(messages.at(-1).content, /First identify prerequisites/);
        return { message: call('hivemind_meta', { operation: 'recall', recall: { query: 'Rama', mode: 'fact', limit: 15 } }, 'multi-recall') };
      }
      if (turn === 2) return { message: call('hivemind_meta', {
        operation: 'save', save: {
          title: 'Rama — HIVE-MIND record',
          content: 'Rama is documented in the governed HIVE receipts as a contact with relevant recorded correspondence.',
          tags: ['person:rama', 'source:hivemind'],
          entities: [{ name: 'Rama', type: 'person' }],
          source_refs: [{ id: 'rama-memory-1', title: 'Rama correspondence' }],
        },
      }, 'multi-save') };
      return { message: { role: 'assistant', content: 'Rama was saved from the governed evidence.' } };
    },
    metaExecutor: async args => {
      operations.push(args.operation);
      if (args.operation === 'recall') return { successful: true, data: { memories: [{ id: 'rama-memory-1', title: 'Rama correspondence', content: 'Verified record.' }] } };
      assert.equal(args.operation, 'save');
      assert.match(args.save.content, /governed HIVE receipts/);
      return { successful: true, data: { saved: true, id: 'rama-summary', title: args.save.title, scope: 'personal' } };
    },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(operations, ['recall', 'save']);
  assert.equal(result.run.scratch.plan.intent, 'multi_task');
  assert.match(result.response, /Rama/);
});

test('an explicit durable-save request crosses the JEV plan node before one governed write', async () => {
  const prisma = fakePrisma();
  const calls = [];
  let turn = 0;
  const runtimeCtx = {
    ...ctx(prisma, 'explicit-save'),
    conversationHistory: [{ role: 'assistant', content: 'Rama is Amar\'s partner and accepted the Prague anniversary invitation.' }],
    _tracedDispatch: async (name, args) => {
      calls.push([name, args]);
      assert.equal(name, 'hivemind_save_memory');
      assert.match(args.title, /Rama/i);
      assert.match(args.content, /Prague anniversary invitation/);
      assert.equal(args.scope, undefined);
      return { memoryId: 'memory-rama' };
    },
  };
  const result = await runUnifiedMetaAgent({
    message: 'Save a dedicated memory about Rama', useTools: false, prisma, ctx: runtimeCtx,
    checkpointer: new MemorySaver(), composio: {},
    decisionStage: saveCapabilityDecision,
    modelStep: async ({ messages, tools }) => {
      turn += 1;
      assert.deepEqual(tools.map(tool => tool.function.name), ['hivemind_meta']);
      assert.match(messages.at(-1).content, /source-grounded memory capsule/i);
      return richSaveToolCall('explicit-rich-save');
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(turn, 1);
  assert.match(result.response, /added .* company brain/i);
  assert.equal(result.run.scratch.plan.intent, 'hivemind_save');
});

test('a JEV-selected preference is classified from its grounded capsule before the durable save', async () => {
  const prisma = fakePrisma();
  const stages = [];
  const result = await runUnifiedMetaAgent({
    message: 'I like playing football.', useTools: false, prisma, ctx: ctx(prisma, 'football-preference'),
    checkpointer: new MemorySaver(), composio: {},
    decisionStage: async input => {
      stages.push(input.stage);
      if (input.stage === 'capability') return {
        status: 'selected', selected: 'hivemind_save', authoritative: true,
        receipt: { source: 'jev', probability: 0.99, margin: 0.97, requestId: 'football-plan' },
      };
      assert.equal(input.stage, 'memory_type');
      assert.match(input.observation.memory_capsule.content, /like playing football/i);
      return {
        status: 'selected', selected: 'preference', authoritative: true,
        receipt: { source: 'jev', probability: 0.98, margin: 0.95, requestId: 'football-memory-type' },
      };
    },
    modelStep: async ({ tools }) => {
      assert.deepEqual(tools.map(tool => tool.function.name), ['hivemind_meta']);
      return { message: call('hivemind_meta', { operation: 'save', save: {
        title: 'Aster Helius — football preference',
        content: 'Aster Helius states that they like playing football.',
        tags: ['person:aster-helius', 'interest:football'],
        entities: ['Aster Helius', 'Football'],
        source_refs: ['conversation:current-user-assertion'],
        scope: 'personal',
      } }, 'football-save') };
    },
    metaExecutor: async args => {
      assert.equal(args.operation, 'save');
      assert.equal(args.save.memory_type, 'preference');
      assert.equal(args.save.scope, 'personal');
      return { successful: true, data: {
        saved: true, memory_id: 'football-preference-1', title: args.save.title, scope: args.save.scope,
      } };
    },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(stages, ['capability', 'memory_type']);
  assert.match(result.response, /as a preference/i);
});

test('the canonical save boundary rejects a generic placeholder capsule', async () => {
  const prisma = fakePrisma();
  const calls = [];
  let modelTurns = 0;
  const result = await runUnifiedMetaAgent({
    message: 'Save this important deployment decision', useTools: false, prisma,
    ctx: {
      ...ctx(prisma, 'reject-generic-save'),
      conversationHistory: [{ role: 'assistant', content: 'The Core release is pinned to commit 067b4dad.' }],
      _tracedDispatch: async (name, args) => {
        calls.push([name, args]);
        assert.notEqual(args.title, 'Saved memory');
        return { saved: true, id: 'memory-rich-after-retry', title: args.title, scope: 'personal' };
      },
    },
    checkpointer: new MemorySaver(), composio: {},
    modelStep: async () => {
      modelTurns += 1;
      if (modelTurns === 1) return call('hivemind_meta', { operation: 'save', save: {
        title: 'Saved memory', content: 'The Core release is pinned to commit 067b4dad.',
      } }, 'generic-save');
      return richSaveToolCall('rich-after-generic-rejection');
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(modelTurns, 2);
  assert.equal(calls.length, 1);
  assert.match(result.response, /added .* company brain/i);
});

test('an inline save-this payload is admitted even when its evidence omits the word memory', async () => {
  const prisma = fakePrisma();
  const calls = [];
  const inline = 'save this Here is the latest important email: PR #707 security review is blocked because the Strix trial ended; billing or manual review is required.';
  const result = await runUnifiedMetaAgent({
    message: inline, useTools: false, prisma,
    ctx: {
      ...ctx(prisma, 'inline-save-evidence'),
      _tracedDispatch: async (name, args) => {
        calls.push([name, args]);
        assert.equal(name, 'hivemind_save_memory');
        assert.notEqual(args.title, 'Saved memory');
        return { saved: true, id: 'inline-save', title: args.title, scope: 'personal' };
      },
    },
    checkpointer: new MemorySaver(), composio: {},
    decisionStage: saveCapabilityDecision,
    modelStep: async () => richSaveToolCall('inline-rich-save'),
  });
  assert.equal(result.status, 'completed');
  assert.equal(calls.length, 1);
});

test('a referential save-all-as-one-memory continuation saves without recall or a model turn', async () => {
  const prisma = fakePrisma();
  const checkpointer = new MemorySaver();
  const calls = [];
  const events = [];
  const runtimeCtx = {
    ...ctx(prisma, 'save-it-continuation'),
    conversationHistory: [{
      role: 'assistant',
      content: 'Rama accepted the Prague anniversary invitation on September 14, 2026.',
    }],
    _tracedDispatch: async (name, args) => {
      calls.push([name, args]);
      assert.equal(name, 'hivemind_save_memory');
      if (calls.length === 1) return {
        saved: false,
        needs_project_choice: true,
        message: 'Choose a destination.',
        scope_options: [{ scope: 'personal', label: 'Personal' }],
        draft: { title: args.title, content: args.content, tags: args.tags },
      };
      assert.equal(args.scope, 'personal');
      assert.match(args.content, /Prague anniversary invitation/);
      return { saved: true, id: 'memory-save-it', title: args.title, scope: args.scope };
    },
  };
  let initialModelTurns = 0;
  const modelStep = async () => {
    initialModelTurns += 1;
    if (initialModelTurns > 1) throw new Error('scope continuation must not invoke model or recall');
    return richSaveToolCall('referential-rich-save');
  };
  const initial = await runUnifiedMetaAgent({
    message: 'save all of it as one memory', useTools: false, prisma, ctx: runtimeCtx,
    checkpointer, composio: {}, modelStep, decisionStage: saveCapabilityDecision,
  });
  assert.equal(initial.status, 'needs_input');
  assert.equal(initial.inputRequests[0].kind, 'memory_scope');
  assert.equal(calls.length, 1);
  const resumed = await runUnifiedMetaAgent({
    message: '', useTools: false, prisma, ctx: runtimeCtx, checkpointer, composio: {}, modelStep,
    onEvent: event => events.push(event), choice: { value: 'personal', run_id: initial.run.id },
  });
  assert.equal(resumed.status, 'completed');
  assert.equal(calls.length, 2);
  assert.match(resumed.response, /added .* to your personal company brain/i);
  assert.match(resumed.response, /I’ll connect the related/i);
  const deltas = events.filter(event => event.type === 'answer_delta').map(event => event.delta);
  assert.ok(deltas.length > 1);
  assert.equal(deltas.join(''), resumed.response);
});

test('a referential save continuation tells the JEV plan about its prepared grounded draft', async () => {
  const prisma = fakePrisma();
  const seen = [];
  const result = await runUnifiedMetaAgent({
    message: 'save this', useTools: false, prisma,
    ctx: {
      ...ctx(prisma, 'save-this-jev-context'),
      conversationHistory: [{ role: 'assistant', content: 'PR #707 is blocked because the Strix trial ended.' }],
      _tracedDispatch: async (name) => {
        assert.equal(name, 'hivemind_save_memory');
        return { saved: true, id: 'saved-jev-context', title: 'PR #707 review status', scope: 'organization' };
      },
    },
    checkpointer: new MemorySaver(), composio: {},
    decisionStage: async input => {
      seen.push(input);
      if (input.stage === 'memory_type') return {
        status: 'selected', selected: 'decision', authoritative: true,
        receipt: { source: 'jev', probability: 0.99, margin: 0.97, requestId: 'referential-memory-type' },
      };
      assert.equal(input.stage, 'capability');
      assert.equal(input.context.explicit_save_language, true);
      assert.deepEqual(input.context.pending_save, { available: true, source: 'conversation', has_explicit_scope: false });
      return { status: 'selected', selected: 'hivemind_save', authoritative: true,
        receipt: { source: 'jev', probability: 0.99, margin: 0.97, requestId: 'referential-save' } };
    },
    modelStep: async ({ messages, tools }) => {
      assert.deepEqual(tools.map(tool => tool.function.name), ['hivemind_meta']);
      assert.match(messages.at(-1).content, /Prepared prior-turn evidence/i);
      return richSaveToolCall('referential-jev-rich-save');
    },
  });
  assert.equal(seen.length, 2);
  assert.equal(result.status, 'completed');
  assert.match(result.response, /organization company brain/i);
});

test('a bare save-it request without a completed answer asks for content without calling recall', async () => {
  const prisma = fakePrisma();
  let modelTurns = 0;
  const result = await runUnifiedMetaAgent({
    message: 'save it', useTools: false, prisma, ctx: ctx(prisma, 'save-it-no-context'),
    checkpointer: new MemorySaver(), composio: {},
    modelStep: async () => { modelTurns += 1; throw new Error('missing continuation payload must not reach model'); },
  });
  assert.equal(result.status, 'needs_input');
  assert.equal(modelTurns, 0);
  assert.match(result.response, /specific fact, decision, or note/i);
});

test('an explicit save without facts asks once before any tool or model call', async () => {
  const prisma = fakePrisma();
  let turns = 0;
  const result = await runUnifiedMetaAgent({
    message: 'Save a dedicated memory about Rama', useTools: false, prisma, ctx: ctx(prisma, 'save-missing-payload'),
    checkpointer: new MemorySaver(), composio: {},
    decisionStage: saveCapabilityDecision,
    modelStep: async () => { turns += 1; throw new Error('missing save content must not reach the model'); },
  });
  assert.equal(turns, 0);
  assert.equal(result.status, 'needs_input');
  assert.match(result.response, /specific fact, decision, or note/i);
});

test('a save without a stated destination interrupts once for scope and resumes the same durable write', async () => {
  const prisma = fakePrisma();
  const checkpointer = new MemorySaver();
  const events = [];
  let writes = 0;
  let turn = 0;
  const runtimeCtx = {
    ...ctx(prisma, 'save-scope'),
    conversationHistory: [{ role: 'assistant', content: 'Rama is important to Amar.' }],
    _tracedDispatch: async (_name, args) => {
      writes += 1;
      if (writes === 1) {
        assert.equal(args.scope, undefined);
        return {
          saved: false, needs_project_choice: true,
          message: 'Choose a destination.',
          scope_options: [{ scope: 'personal', label: 'Personal' }, { scope: 'organization', label: 'Organization' }],
          draft: { title: args.title, content: args.content, tags: args.tags, memory_type: 'fact' },
        };
      }
      assert.equal(args.scope, 'personal');
      return { saved: true, id: 'memory-scoped', title: args.title, scope: args.scope };
    },
  };
  const modelStep = async () => {
    turn += 1;
    if (turn > 1) throw new Error('scope continuation must complete from its checkpoint without a second model turn');
    return richSaveToolCall('scope-rich-save');
  };
  const initial = await runUnifiedMetaAgent({
    message: 'Save a dedicated memory about Rama', useTools: false, prisma, ctx: runtimeCtx,
    checkpointer, modelStep, composio: {}, decisionStage: saveCapabilityDecision,
    onEvent: event => events.push(event),
  });
  assert.equal(initial.status, 'needs_input');
  assert.equal(initial.inputRequests[0].kind, 'memory_scope');
  assert.equal(writes, 1);
  const scopePrepared = events.find(event => event.type === 'tool_result' && event.name === 'hivemind_save_memory');
  assert.equal(scopePrepared.status, 'needs_input');
  assert.match(scopePrepared.summary, /prepared; choose a destination/i);
  assert.equal(scopePrepared.harness_version, UNIFIED_META_HARNESS_VERSION);
  const resumed = await runUnifiedMetaAgent({
    message: '', useTools: false, prisma, ctx: runtimeCtx, checkpointer, modelStep, composio: {},
    choice: { value: 'personal', run_id: initial.run.id },
  });
  assert.equal(resumed.status, 'completed');
  assert.equal(writes, 2);
  assert.match(resumed.response, /personal company brain/i);
  assert.equal(turn, 1);
});

test('a standalone organization scope save seals from its receipt without a fallback pass', async () => {
  const prisma = fakePrisma();
  const checkpointer = new MemorySaver();
  let writes = 0;
  const runtimeCtx = {
    ...ctx(prisma, 'save-organization-seal'),
    conversationHistory: [{ role: 'assistant', content: 'The organization approved the reliability release.' }],
    _tracedDispatch: async (_name, args) => {
      writes += 1;
      if (writes === 1) return {
        saved: false,
        needs_project_choice: true,
        message: 'Choose a destination.',
        scope_options: [{ scope: 'organization', label: 'Organization' }],
        draft: { title: args.title, content: args.content, tags: args.tags, memory_type: 'fact' },
      };
      assert.equal(args.scope, 'organization');
      return { saved: true, id: 'memory-organization', title: args.title, scope: args.scope };
    },
  };
  const initial = await runUnifiedMetaAgent({
    message: 'Save this as one memory', useTools: false, prisma, ctx: runtimeCtx,
    checkpointer, composio: {}, decisionStage: saveCapabilityDecision,
    modelStep: async () => richSaveToolCall('organization-rich-save'),
  });
  assert.equal(initial.status, 'needs_input');
  const resumed = await runUnifiedMetaAgent({
    message: '', useTools: false, prisma, ctx: runtimeCtx, checkpointer, composio: {},
    choice: { value: 'organization', run_id: initial.run.id },
    modelStep: async () => { throw new Error('the receipt must seal the standalone save'); },
  });
  assert.equal(resumed.status, 'completed');
  assert.equal(writes, 2);
  assert.match(resumed.response, /organization company brain/i);
  assert.equal(resumed.run.scratch.workflow_transition, null);
});

test('scope continuation preserves the original canonical save payload and emits a final receipt stream', async () => {
  const prisma = fakePrisma();
  const checkpointer = new MemorySaver();
  const events = [];
  const calls = [];
  const runtimeCtx = {
    ...ctx(prisma, 'save-scope-payload'),
    conversationHistory: [{ role: 'assistant', content: 'The release decision was approved with evidence A and B.' }],
    _tracedDispatch: async (_name, args) => {
      calls.push(args);
      if (calls.length === 1) return {
        saved: false,
        needs_project_choice: true,
        message: 'Choose a destination.',
        // Simulate an older Core draft that omitted tags and source evidence.
        draft: { title: 'Release decision', content: 'truncated' },
        scope_options: [{ scope: 'personal', label: 'Personal' }],
      };
      return { saved: true, id: 'memory-payload', title: args.title, scope: args.scope };
    },
  };
  const initial = await runUnifiedMetaAgent({
    message: 'Save this to Hivemind as one memory', useTools: false, prisma, ctx: runtimeCtx,
    checkpointer, composio: {}, decisionStage: saveCapabilityDecision,
    modelStep: async () => ({ message: call('hivemind_meta', { operation: 'save', save: {
      title: 'Reliability release decision — approved evidence',
      content: 'The release decision was approved with evidence A and B, as stated in the preceding assistant answer.',
      source_type: 'conversation', tags: ['decision:reliability-release'],
      entities: ['Reliability release'], source_refs: ['conversation:prior-assistant-answer'],
    } }, 'scope-payload-rich-save') }),
  });
  assert.equal(initial.status, 'needs_input');
  const resumed = await runUnifiedMetaAgent({
    message: '', useTools: false, prisma, ctx: runtimeCtx, checkpointer, composio: {},
    onEvent: event => events.push(event), choice: { value: 'personal', run_id: initial.run.id },
    modelStep: async () => { throw new Error('scope continuation must not invoke the model'); },
  });
  assert.equal(resumed.status, 'completed');
  assert.equal(calls.length, 2);
  assert.match(calls[1].content, /release decision was approved/i);
  const deltas = events.filter(event => event.type === 'answer_delta').map(event => event.delta);
  assert.ok(deltas.length > 1);
  assert.equal(deltas.join(''), resumed.response);
  assert.match(resumed.response, /company brain/i);
  assert.equal(resumed.steps?.at(-1)?.slug, 'hivemind_save_memory');
});

test('decision summaries keep non-decision events out of the final synthesis', async () => {
  const prisma = fakePrisma();
  let turn = 0;
  await runUnifiedMetaAgent({
    message: 'Summarize my recent decisions', useTools: false, prisma, ctx: ctx(prisma, 'decision-summary'),
    checkpointer: new MemorySaver(), composio: {},
    modelStep: async () => {
      turn += 1;
      if (turn === 1) return { message: call('hivemind_meta', { operation: 'recall', recall: { query: 'recent decisions', limit: 10 } }, 'decision-recall') };
      throw new Error('decision synthesis must use the verified receipt stream');
    },
    metaExecutor: async () => ({ successful: true, data: { memories: [{ title: 'Approved roadmap', memory_type: 'decision', content: 'Approved the September roadmap.' }, { title: 'Calendar invitation', memory_type: 'event', content: 'Accepted a trip invitation.' }] } }),
    finalStream: async ({ messages, onDelta }) => {
      assert.match(messages[0].content, /Do not label an email, calendar event, relationship, or inferred outcome as a decision/);
      await onDelta('You approved the September roadmap.');
      return { ok: true, content: 'You approved the September roadmap.' };
    },
  });
});

test('the same graph progressively searches, loads one selected schema, executes, and renders provider records', async () => {
  const prisma = fakePrisma();
  const events = [];
  const calls = [];
  let turn = 0;
  const modelStep = async ({ tools, messages }) => {
    turn += 1;
    assert.deepEqual(tools.map(row => row.function.name), turn <= 3 ? ['hivemind_meta', 'hivemind_connected_task'] : []);
    if (turn === 4) assert.deepEqual(messages.map(row => row.role), ['system', 'user', 'system']);
    if (turn === 1) return { message: call('hivemind_connected_task', { action: 'search', queries: [{ use_case: 'Fetch the five newest unread Gmail emails with subject sender and received timestamp' }], session: { generate_id: true }, toolkits: ['gmail'] }, 'c1') };
    if (turn === 2) return { message: call('hivemind_connected_task', { action: 'schemas', tool_slugs: ['GMAIL_FETCH_EMAILS'] }, 'c2') };
    if (turn === 3) return { message: call('hivemind_connected_task', { action: 'execute', tool_slug: 'GMAIL_FETCH_EMAILS', arguments: { query: 'is:unread', max_results: 5 } }, 'c3') };
    return { message: { role: 'assistant', content: '| Subject | Sender | Time |\n|---|---|---|\n| Security alert | Google | 17:08 |\n| Build passed | GitHub | 16:30 |' } };
  };
  const composio = {
    async discoverSessionTools(_org, input) {
      calls.push(['search', input.hydrateSchemas, input.searchPayload.queries]);
      return { sessionId: 'session-1', workflowSessionId: 'workflow-1', primaryToolSlugs: ['GMAIL_FETCH_EMAILS'], relatedToolSlugs: [], toolkitConnectionStatuses: { gmail: 'connected' }, recommendedPlanSteps: ['Fetch emails'] };
    },
    async getSessionToolSchemas(sessionId, slugs) {
      calls.push(['schemas', sessionId, slugs]);
      return { GMAIL_FETCH_EMAILS: { read_only: true, input_schema: { type: 'object', additionalProperties: false, required: ['query', 'max_results'], properties: { query: { type: 'string' }, max_results: { type: 'integer' } } } } };
    },
    async executeToolsParallel(_org, input, options) {
      calls.push(['execute', input, options]);
      return [{ successful: true, data: { messages: [{ subject: 'Security alert', sender: 'Google', time: '17:08' }, { subject: 'Build passed', sender: 'GitHub', time: '16:30' }] } }];
    },
  };
  const result = await runUnifiedMetaAgent({ message: 'What are my five latest unread emails?', useTools: true, prisma, ctx: ctx(prisma, 'read'), checkpointer: new MemorySaver(), modelStep, composio, onEvent: event => events.push(event) });
  assert.equal(result.status, 'completed');
  assert.match(result.response, /\| Subject \| Sender \| Time \|/);
  assert.match(result.response, /\n\|[-: ]+\|[-: ]+\|[-: ]+\|/);
  assert.deepEqual(calls[0].slice(0, 2), ['search', false]);
  assert.deepEqual(calls[1], ['schemas', 'session-1', ['GMAIL_FETCH_EMAILS']]);
  assert.equal(calls.filter(row => row[0] === 'execute').length, 1);
  assert.ok(events.some(event => event.type === 'tool_result' && event.name === 'GMAIL_FETCH_EMAILS'));
});

test('a fresh turn never replays a prior connected result from the durable graph checkpoint', async () => {
  const prisma = fakePrisma();
  const checkpointer = new MemorySaver();
  const runtimeCtx = ctx(prisma, 'fresh-connected-turn');
  const discoveredUseCases = [];
  const modelRequests = [];
  const modelTurns = new Map();
  const modelStep = async ({ messages }) => {
    const request = messages.filter(row => row.role === 'user').at(-1)?.content || '';
    const turn = (modelTurns.get(request) || 0) + 1;
    modelTurns.set(request, turn);
    if (turn === 1) {
      modelRequests.push(request);
      return { message: call('hivemind_connected_task', {
        action: 'search', toolkits: ['example'], queries: [{ use_case: request }], session: { generate_id: true },
      }, `fresh-${modelRequests.length}`) };
    }
    if (turn === 2) return { message: call('hivemind_connected_task', { action: 'schemas', tool_slugs: ['EXAMPLE_LIST'] }, `schema-${request}`) };
    if (turn === 3) return { message: call('hivemind_connected_task', { action: 'execute', tool_slug: 'EXAMPLE_LIST', arguments: { query: request } }, `execute-${request}`) };
    return { message: { role: 'assistant', content: `Fresh result for: ${request}` } };
  };
  const composio = {
    async listConnectedAccounts() { return [{ toolkit: 'example', status: 'ACTIVE' }]; },
    async discoverSessionTools(_org, input) {
      discoveredUseCases.push(input.searchPayload.queries[0].use_case);
      return { sessionId: `session-${discoveredUseCases.length}`, primaryToolSlugs: ['EXAMPLE_LIST'], relatedToolSlugs: [], toolkitConnectionStatuses: { example: 'connected' } };
    },
    async getSessionToolSchemas() {
      return { EXAMPLE_LIST: { read_only: true, input_schema: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string' } } } } };
    },
    async executeToolsParallel(_org, input) {
      return [{ successful: true, data: { records: [{ query: input[0].arguments.query }] } }];
    },
  };

  const first = await runUnifiedMetaAgent({
    message: 'Find the latest important connected records', useTools: true, prisma, ctx: runtimeCtx, checkpointer, modelStep, composio,
  });
  const second = await runUnifiedMetaAgent({
    message: 'Find the latest records from Rama', useTools: true, prisma, ctx: runtimeCtx, checkpointer, modelStep, composio,
  });

  assert.equal(first.status, 'completed', first.response);
  assert.match(first.response, /important connected records/);
  assert.equal(second.status, 'completed');
  assert.match(second.response, /records from Rama/);
  assert.deepEqual(modelRequests, ['Find the latest important connected records', 'Find the latest records from Rama']);
  assert.deepEqual(discoveredUseCases, modelRequests);
});

test('receipt-grounded final synthesis emits progressive SSE deltas without changing the durable connected workflow', async () => {
  const prisma = fakePrisma();
  const events = [];
  let turn = 0;
  const result = await runUnifiedMetaAgent({
    message: 'Show the latest connected record', useTools: true, prisma, ctx: ctx(prisma, 'stream-final'), checkpointer: new MemorySaver(),
    onEvent: event => events.push(event),
    modelStep: async () => {
      turn += 1;
      if (turn === 1) return { message: call('hivemind_connected_task', { action: 'search', toolkits: ['example'], queries: [{ use_case: 'Read the latest record' }] }, 'sf1') };
      if (turn === 2) return { message: call('hivemind_connected_task', { action: 'schemas', tool_slugs: ['EXAMPLE_FETCH'] }, 'sf2') };
      if (turn === 3) return { message: call('hivemind_connected_task', { action: 'execute', tool_slug: 'EXAMPLE_FETCH', arguments: { limit: 1 } }, 'sf3') };
      throw new Error('the buffered final model call must not run after a verified receipt');
    },
    finalStream: async ({ messages, onDelta }) => {
      assert.deepEqual(messages.map(row => row.role), ['system', 'user', 'system']);
      await onDelta('The latest ');
      await onDelta('record is ready.');
      return { ok: true, content: 'The latest record is ready.', usage: { total_tokens: 12 } };
    },
    composio: {
      async listConnectedAccounts() { return [{ toolkit: 'example', status: 'ACTIVE' }]; },
      async discoverSessionTools() { return { sessionId: 'stream-session', primaryToolSlugs: ['EXAMPLE_FETCH'], relatedToolSlugs: [], toolkitConnectionStatuses: { example: 'connected' } }; },
      async getSessionToolSchemas() { return { EXAMPLE_FETCH: { read_only: true, input_schema: { type: 'object', required: ['limit'], properties: { limit: { type: 'integer' } } } } }; },
      async executeToolsParallel() { return [{ successful: true, data: { records: [{ id: 'record-1', title: 'Latest record' }] } }]; },
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.response, 'The latest record is ready.');
  assert.deepEqual(events.filter(event => event.type === 'answer_delta').map(event => event.delta), ['The latest ', 'record is ready.']);
  assert.ok(events.some(event => event.type === 'answer_started'));
  assert.ok(events.some(event => event.type === 'answer_completed'));
  assert.equal(result.usage.at(-1).total_tokens, 12);
});

test('Jev narrows legacy Composio discovery and blocks an unselected write in the same turn', async () => {
  const prisma = fakePrisma();
  const events = [];
  const decisionStages = [];
  let turn = 0;
  const modelStep = async () => {
    turn += 1;
    if (turn === 1) return { message: call('hivemind_connected_task', {
      action: 'search', toolkits: ['gmail'],
      queries: [{ use_case: 'Find the newest Gmail message from Rama and return date and subject without changing it' }],
    }, 'j1') };
    if (turn === 2) return { message: call('hivemind_connected_task', { action: 'schemas', tool_slugs: ['GMAIL_ADD_LABEL_TO_EMAIL'] }, 'j2') };
    if (turn === 3) return { message: call('hivemind_connected_task', { action: 'execute', tool_slug: 'GMAIL_FETCH_EMAILS', arguments: { query: 'from:Rama', max_results: 1 } }, 'j3') };
    return { message: { role: 'assistant', content: 'The newest message is **Hello** from **September 20, 2026**.' } };
  };
  const composio = {
    async listConnectedAccounts() { return [{ toolkit: 'gmail', status: 'ACTIVE' }]; },
    async discoverSessionTools() {
      const tools = [
        { type: 'function', function: { name: 'composio_gmail_fetch_emails', description: 'Read Gmail messages.', parameters: { type: 'object', properties: {} } }, _composio: { slug: 'GMAIL_FETCH_EMAILS', toolkit: 'gmail', read_only: true } },
        { type: 'function', function: { name: 'composio_gmail_add_label_to_email', description: 'Add a label to a message.', parameters: { type: 'object', properties: {} } }, _composio: { slug: 'GMAIL_ADD_LABEL_TO_EMAIL', toolkit: 'gmail', read_only: false } },
      ];
      return {
        sessionId: 'jev-session', tools,
        primaryToolSlugs: ['GMAIL_FETCH_EMAILS', 'GMAIL_ADD_LABEL_TO_EMAIL'], relatedToolSlugs: [],
        toolkitConnectionStatuses: { gmail: { status: 'ACTIVE' } },
      };
    },
    async getSessionToolSchemas(_session, slugs) {
      assert.deepEqual(slugs, ['GMAIL_FETCH_EMAILS']);
      return { GMAIL_FETCH_EMAILS: { read_only: true, input_schema: { type: 'object', required: ['query', 'max_results'], properties: { query: { type: 'string' }, max_results: { type: 'integer' } } } } };
    },
    async executeToolsParallel() { return [{ successful: true, data: { messages: [{ subject: 'Hello', received_at: '2026-09-20' }] } }]; },
  };
  const decisionStage = async input => {
    decisionStages.push(input.stage);
    return input.stage === 'composio_selection'
      ? { status: 'selected', selected: 'use:GMAIL_FETCH_EMAILS', authoritative: true, receipt: { source: 'jev' } }
      : { status: 'selected', selected: 'composio_search', authoritative: true, receipt: { source: 'jev' } };
  };
  const result = await runUnifiedMetaAgent({
    message: 'Find my last email from Rama. Do not modify it.', useTools: true, prisma,
    ctx: ctx(prisma, 'jev-read'), checkpointer: new MemorySaver(), modelStep, composio, decisionStage,
    onEvent: event => events.push(event),
  });
  assert.equal(result.status, 'completed');
  assert.match(result.response, /Hello/);
  assert.ok(result.steps.some(step => step.slug === 'hivemind_connected_task' && step.status === 'error'));
  assert.ok(events.some(event => event.type === 'decision' && event.stage === 'composio_selection'
    && event.selected === 'use:GMAIL_FETCH_EMAILS' && event.source === 'jev'));
  assert.deepEqual(decisionStages, ['capability', 'composio_selection']);
  assert.deepEqual(result.run.scratch.selected_tool_slugs, ['GMAIL_FETCH_EMAILS']);
});

test('execute progressively hydrates its authorized schema and refuses empty provider defaults', async () => {
  const prisma = fakePrisma();
  const calls = [];
  let turn = 0;
  const result = await runUnifiedMetaAgent({
    message: 'Find my last five emails from Rama', useTools: true, prisma, ctx: ctx(prisma, 'auto-schema'), checkpointer: new MemorySaver(),
    modelStep: async () => {
      turn += 1;
      if (turn === 1) return { message: call('hivemind_connected_task', { action: 'search', toolkits: ['gmail'], queries: [{ use_case: 'Find the last five Gmail emails from Rama' }] }, 'a1') };
      if (turn === 2) return { message: call('hivemind_connected_task', { action: 'execute', tool_slug: 'gmail_fetch_emails', arguments: {} }, 'a2') };
      if (turn === 3) return { message: call('hivemind_connected_task', { action: 'execute', tool_slug: 'GMAIL_FETCH_EMAILS', arguments: { query: 'from:Rama', max_results: 5 } }, 'a3') };
      return { message: { role: 'assistant', content: '| Subject | Sender | Time |\n|---|---|---|\n| Hello | Rama | Today |' } };
    },
    composio: {
      async listConnectedAccounts() { return [{ toolkit: 'gmail', status: 'ACTIVE' }]; },
      async discoverSessionTools() { return { sessionId: 'auto-session', primaryToolSlugs: ['GMAIL_FETCH_EMAILS'], relatedToolSlugs: [], toolkitConnectionStatuses: { gmail: 'connected' } }; },
      async getSessionToolSchemas(session, slugs) { calls.push(['schemas', session, slugs]); return { GMAIL_FETCH_EMAILS: { read_only: true, input_schema: { type: 'object', required: ['query', 'max_results'], properties: { query: { type: 'string' }, max_results: { type: 'integer' } } } } }; },
      async executeToolsParallel(_org, tools, options) { calls.push(['execute', tools, options]); return [{ successful: true, data: { messages: [{ subject: 'Hello', sender: 'Rama', time: 'Today' }] } }]; },
    },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls[0], ['schemas', 'auto-session', ['GMAIL_FETCH_EMAILS']]);
  assert.equal(calls[1][0], 'execute');
  assert.equal(calls.filter(row => row[0] === 'execute').length, 1);
  assert.deepEqual(calls[1][1][0].arguments, { query: 'from:Rama', max_results: 5 });
});

test('connected search generically infers an explicitly named active toolkit when the model omits toolkits', async () => {
  const prisma = fakePrisma();
  let turn = 0;
  let discoveredToolkits = null;
  const result = await runUnifiedMetaAgent({
    message: 'Show my unread Gmail emails', useTools: true, prisma, ctx: ctx(prisma, 'infer-toolkit'), checkpointer: new MemorySaver(),
    modelStep: async () => (++turn === 1
      ? { message: call('hivemind_connected_task', { action: 'search', queries: [{ use_case: 'Fetch unread Gmail emails' }] }, 'i1') }
      : { message: { role: 'assistant', content: 'No matching emails were returned.' } }),
    composio: {
      async listConnectedAccounts() { return [{ toolkit: 'gmail', status: 'ACTIVE' }, { toolkit: 'linkedin', status: 'ACTIVE' }]; },
      async discoverSessionTools(_org, input) {
        discoveredToolkits = input.toolkits;
        return { sessionId: 'session-infer', primaryToolSlugs: ['GMAIL_FETCH_EMAILS'], relatedToolSlugs: [], toolkitConnectionStatuses: { gmail: 'connected' } };
      },
    },
  });
  assert.equal(result.status, 'error');
  assert.deepEqual(discoveredToolkits, ['gmail']);
});

test('connected capability concepts are resolved to valid authenticated toolkit slugs before session creation', async () => {
  const prisma = fakePrisma();
  const resolved = [];
  let discovered = null;
  const result = await runUnifiedMetaAgent({
    message: 'Search my email for the five newest messages', useTools: true, prisma,
    ctx: ctx(prisma, 'resolve-email-concept'), checkpointer: new MemorySaver(),
    modelStep: async () => ({ message: call('hivemind_connected_task', {
      action: 'search', toolkits: ['email'], queries: [{ use_case: 'Get the five newest email messages' }],
    }, 'resolve-email-1') }),
    composio: {
      async listConnectedAccounts() { return [{ toolkit: 'gmail', status: 'ACTIVE' }]; },
      async resolveToolkitConcepts(concepts, { preferred }) {
        resolved.push({ concepts, preferred });
        return ['gmail'];
      },
      async discoverSessionTools(_org, input) {
        discovered = input.toolkits;
        return { sessionId: 'resolve-email-session', primaryToolSlugs: [], relatedToolSlugs: [], toolkitConnectionStatuses: { gmail: 'connected' } };
      },
    },
  });
  assert.equal(result.status, 'error');
  assert.ok(resolved.some(row => JSON.stringify(row) === JSON.stringify({ concepts: ['email'], preferred: ['gmail'] })));
  assert.deepEqual(discovered, ['gmail']);
});

test('switching connected providers never reuses the prior provider session or workflow session', async () => {
  const prisma = fakePrisma();
  const discoveries = [];
  let turn = 0;
  const result = await runUnifiedMetaAgent({
    message: 'Check the relevant connected records', useTools: true, prisma,
    ctx: ctx(prisma, 'provider-session-switch'), checkpointer: new MemorySaver(),
    modelStep: async () => {
      turn += 1;
      if (turn === 1) return { message: call('hivemind_connected_task', {
        action: 'search', toolkits: ['outlook'], session: { id: 'model-outlook-workflow' },
        queries: [{ use_case: 'Check the relevant Outlook messages' }],
      }, 'provider-1') };
      if (turn === 2) return { message: call('hivemind_connected_task', {
        action: 'search', toolkits: ['gmail'], session: { id: 'stale-outlook-workflow' },
        queries: [{ use_case: 'Check the relevant Gmail messages' }],
      }, 'provider-2') };
      return { message: { role: 'assistant', content: 'Provider discovery completed.' } };
    },
    composio: {
      async listConnectedAccounts() {
        return [{ toolkit: 'outlook', status: 'ACTIVE' }, { toolkit: 'gmail', status: 'ACTIVE' }];
      },
      async discoverSessionTools(_org, input) {
        discoveries.push({ toolkits: input.toolkits, sessionId: input.sessionId, workflow: input.searchPayload.session });
        const toolkit = input.toolkits[0];
        return {
          sessionId: toolkit === 'outlook' ? 'outlook-session' : 'gmail-session',
          workflowSessionId: toolkit === 'outlook' ? 'outlook-workflow' : 'gmail-workflow',
          primaryToolSlugs: [], relatedToolSlugs: [],
          toolkitConnectionStatuses: { [toolkit]: 'connected' },
        };
      },
    },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(discoveries, [
    { toolkits: ['outlook'], sessionId: null, workflow: { generate_id: true } },
    { toolkits: ['gmail'], sessionId: null, workflow: { generate_id: true } },
  ]);
});

test('a named connected toolkit cannot seal from hivemind_meta without Composio discovery', async () => {
  const prisma = fakePrisma();
  const observed = [];
  let turn = 0;
  const result = await runUnifiedMetaAgent({
    message: 'What was my last message in Slack?', useTools: true, prisma, ctx: ctx(prisma, 'connected-obligation'), checkpointer: new MemorySaver(),
    modelStep: async ({ messages }) => {
      turn += 1;
      observed.push(messages.at(-1)?.content || '');
      if (turn === 1) return { message: call('hivemind_meta', { operation: 'recall', recall: { query: 'last Slack message' } }, 'co1') };
      if (turn === 2) return { message: { role: 'assistant', content: "I don't have access to Slack." } };
      return { message: call('hivemind_connected_task', { action: 'search', toolkits: ['slack'], queries: [{ use_case: 'Find the authenticated user last Slack message with channel and timestamp' }] }, 'co2') };
    },
    metaExecutor: async () => ({ successful: true, data: { memories: [] } }),
    composio: {
      async listConnectedAccounts() { return [{ toolkit: 'slack', status: 'EXPIRED' }]; },
      async discoverSessionTools() {
        return { sessionId: 'slack-session', primaryToolSlugs: ['SLACK_SEARCH_MESSAGES'], relatedToolSlugs: [], toolkitConnectionStatuses: { slack: 'disconnected' } };
      },
      async manageSessionConnections() { return { redirectUrl: 'https://connect.example/slack' }; },
    },
  });
  assert.equal(result.status, 'needs_input');
  assert.equal(result.inputRequests[0].toolkit, 'slack');
  assert.match(result.inputRequests[0].prompt, /Connect slack/);
  assert.ok(observed.some(value => /no connected-app discovery receipt exists/i.test(value)));
});

test('connected search reuses an authenticated organization-scoped connection when user scope has not migrated yet', async () => {
  const prisma = fakePrisma();
  let turn = 0;
  let discoveryScope = null;
  const result = await runUnifiedMetaAgent({
    message: 'Show my unread Gmail emails', useTools: true, prisma, ctx: ctx(prisma, 'org-scope'), checkpointer: new MemorySaver(),
    modelStep: async () => (++turn === 1
      ? { message: call('hivemind_connected_task', { action: 'search', toolkits: ['gmail'], queries: [{ use_case: 'Fetch unread Gmail emails' }] }, 'o1') }
      : { message: { role: 'assistant', content: 'No matching emails were returned.' } }),
    composio: {
      async listConnectedAccounts(_org, options) {
        return options.connectionScope === 'org' ? [{ toolkit: 'gmail', status: 'ACTIVE' }] : [{ toolkit: 'linkedin', status: 'ACTIVE' }];
      },
      async discoverSessionTools(_org, input) {
        discoveryScope = input.connectionScope;
        return { sessionId: 'session-org', primaryToolSlugs: ['GMAIL_FETCH_EMAILS'], relatedToolSlugs: [], toolkitConnectionStatuses: { gmail: 'connected' } };
      },
    },
  });
  assert.equal(result.status, 'error');
  assert.equal(discoveryScope, 'org');
});

test('the gateway grounds a contradictory model toolkit in the authenticated user request', async () => {
  const prisma = fakePrisma();
  let turn = 0;
  let selected = null;
  const result = await runUnifiedMetaAgent({
    message: 'Show my unread Gmail emails', useTools: true, prisma, ctx: ctx(prisma, 'ground-toolkit'), checkpointer: new MemorySaver(),
    modelStep: async () => (++turn === 1
      ? { message: call('hivemind_connected_task', { action: 'search', toolkits: ['linkedin'], queries: [{ use_case: 'Read recent messages' }] }, 'g1') }
      : { message: { role: 'assistant', content: 'No matching emails were returned.' } }),
    composio: {
      async listConnectedAccounts() { return [{ toolkit: 'gmail', status: 'ACTIVE' }, { toolkit: 'linkedin', status: 'ACTIVE' }]; },
      async discoverSessionTools(_org, input) {
        selected = input.toolkits;
        return { sessionId: 'session-ground', primaryToolSlugs: ['GMAIL_FETCH_EMAILS'], relatedToolSlugs: [], toolkitConnectionStatuses: { gmail: 'connected' } };
      },
    },
  });
  assert.equal(result.status, 'error');
  assert.deepEqual(selected, ['gmail']);
});

test('provider schema loading always uses the durable graph session, never a model supplied id', async () => {
  const prisma = fakePrisma();
  let turn = 0;
  let schemaSession = null;
  const result = await runUnifiedMetaAgent({
    message: 'Show my unread Gmail emails', useTools: true, prisma, ctx: ctx(prisma, 'session-authority'), checkpointer: new MemorySaver(),
    modelStep: async () => {
      turn += 1;
      if (turn === 1) return { message: call('hivemind_connected_task', { action: 'search', toolkits: ['gmail'], queries: [{ use_case: 'Fetch unread Gmail emails' }] }, 's1') };
      if (turn === 2) return { message: call('hivemind_connected_task', { action: 'schemas', session_id: 'model-invented', tool_slugs: ['GMAIL_FETCH_EMAILS'] }, 's2') };
      return { message: { role: 'assistant', content: 'No matching emails were returned.' } };
    },
    composio: {
      async listConnectedAccounts() { return [{ toolkit: 'gmail', status: 'ACTIVE' }]; },
      async discoverSessionTools() { return { sessionId: 'trusted-session', primaryToolSlugs: ['GMAIL_FETCH_EMAILS'], relatedToolSlugs: [], toolkitConnectionStatuses: { gmail: 'connected' } }; },
      async getSessionToolSchemas(sessionId) { schemaSession = sessionId; return { GMAIL_FETCH_EMAILS: { input_schema: { type: 'object', properties: {} } } }; },
    },
  });
  assert.equal(result.status, 'error');
  assert.equal(schemaSession, 'trusted-session');
});

test('a connected write becomes a durable approval and executes exactly once after resume', async () => {
  const prisma = fakePrisma();
  const checkpointer = new MemorySaver();
  let executions = 0;
  let turn = 0;
  const modelStep = async () => {
    turn += 1;
    if (turn === 1) return { message: call('hivemind_connected_task', { action: 'search', queries: [{ use_case: 'Send one Gmail email after human approval' }], session: { generate_id: true }, toolkits: ['gmail'] }, 'w1') };
    if (turn === 2) return { message: call('hivemind_connected_task', { action: 'schemas', tool_slugs: ['GMAIL_SEND_EMAIL'] }, 'w2') };
    if (turn === 3) return { message: call('hivemind_connected_task', { action: 'execute', tool_slug: 'GMAIL_SEND_EMAIL', arguments: { recipient_email: 'rama@example.test', subject: 'Singulance', body: 'A concise update.' } }, 'w3') };
    return { message: { role: 'assistant', content: 'The approved email was sent once.' } };
  };
  const composio = {
    async discoverSessionTools() { return { sessionId: 'session-write', primaryToolSlugs: ['GMAIL_SEND_EMAIL'], relatedToolSlugs: [], toolkitConnectionStatuses: { gmail: 'connected' } }; },
    async getSessionToolSchemas() { return { GMAIL_SEND_EMAIL: { is_write: true, input_schema: { type: 'object', additionalProperties: false, required: ['recipient_email', 'subject', 'body'], properties: { recipient_email: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } } } } }; },
    async executeToolsParallel() { executions += 1; return [{ successful: true, data: { message_id: 'sent-1' } }]; },
  };
  const runtimeCtx = ctx(prisma, 'write');
  const first = await runUnifiedMetaAgent({ message: 'Send Rama an email about Singulance', useTools: true, prisma, ctx: runtimeCtx, checkpointer, modelStep, composio });
  assert.equal(first.status, 'pending');
  assert.equal(prisma.drafts[0].status, 'draft');
  assert.equal(executions, 0);
  const completed = await runUnifiedMetaAgent({ message: 'Send Rama an email about Singulance', useTools: true, prisma, ctx: { ...runtimeCtx, unifiedRunId: first.run.id }, checkpointer, modelStep, composio, choice: { action: 'approve', run_id: first.run.id } });
  assert.equal(completed.status, 'completed');
  assert.equal(prisma.drafts[0].status, 'sent');
  assert.equal(executions, 1);
});
