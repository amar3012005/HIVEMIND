import test from 'node:test';
import assert from 'node:assert/strict';
import { MemorySaver } from '@langchain/langgraph';

import { runUnifiedMetaAgent } from '../../src/agent/unified-langgraph-agent.js';

test('unified graph retains the existing SSE and final response fields consumed by Overview chat', async () => {
  const events = [];
  let call = 0;
  const prisma = { pendingWrite: {} };
  const result = await runUnifiedMetaAgent({
    message: 'What do we know about the release?',
    useTools: false,
    prisma,
    ctx: { orgId: 'o', userId: 'u', threadId: 't', language: 'en', prisma },
    checkpointer: new MemorySaver(),
    composio: {},
    onEvent: event => events.push(event),
    modelStep: async () => {
      call += 1;
      return call === 1
        ? { message: { role: 'assistant', content: null, tool_calls: [{ id: 'r1', type: 'function', function: { name: 'hivemind_meta', arguments: '{"operation":"recall","recall":{"query":"release"}}' } }] } }
        : { message: { role: 'assistant', content: 'The release remains feature-gated.' } };
    },
    metaExecutor: async () => ({ successful: true, data: { memories: [{ title: 'Release decision', content: 'Keep the release feature-gated.' }] } }),
  });

  assert.equal(result.response, 'The release remains feature-gated.');
  assert.ok(Array.isArray(result.steps));
  assert.ok(Array.isArray(result.sources));
  assert.ok(Array.isArray(result.citations));
  assert.ok(Array.isArray(result.draftIds));
  assert.ok(Array.isArray(result.pendingActions));
  assert.deepEqual(events.filter(event => ['tool_start', 'tool_result', 'answer_delta', 'finish'].includes(event.type)).map(event => event.type), ['tool_start', 'tool_result', 'answer_delta', 'finish']);
  assert.deepEqual(events.filter(event => event.type === 'agent_state').map(event => event.state), ['running', 'sealed']);
});

test('legacy chat exposes the Jev-selected gateway and native typed tools when Jev defers', async () => {
  const prisma = { pendingWrite: {} };
  const surfaces = [];
  const common = {
    useTools: true,
    prisma,
    checkpointer: new MemorySaver(),
    composio: { async listConnectedAccounts() { return []; } },
    modelStep: async ({ tools, messages }) => {
      surfaces.push(tools.map(tool => tool.function.name));
      if (messages.some(row => row.role === 'system' && row.content.includes('Selected executor intent: fallback_harness'))) {
        assert.match(messages.find(row => row.role === 'system' && row.content.includes('Selected executor intent: fallback_harness')).content, /LangGraph-native tool planner/i);
      }
      return { message: { role: 'assistant', content: 'Done.' } };
    },
  };

  await runUnifiedMetaAgent({
    ...common,
    message: 'Check Gmail for the latest message',
    ctx: { orgId: 'o', userId: 'u', threadId: 'jev-selected', language: 'en', prisma },
    decisionStage: async () => ({ status: 'selected', selected: 'composio_search', authoritative: true, receipt: { source: 'jev' } }),
  });
  await runUnifiedMetaAgent({
    ...common,
    message: 'Handle this ambiguous request',
    ctx: { orgId: 'o', userId: 'u', threadId: 'jev-defer', language: 'en', prisma },
    decisionStage: async () => ({ status: 'defer', selected: null, authoritative: false, receipt: { source: 'fallback' } }),
  });

  assert.deepEqual(surfaces[0], ['hivemind_connected_task']);
  assert.ok(surfaces.slice(1, -1).every(surface => surface.length === 1 && surface[0] === 'hivemind_connected_task'),
    'an explicit connected-source request cannot be repaired by switching to HIVE');
  assert.deepEqual(surfaces.at(-1), ['hivemind_meta', 'hivemind_connected_task']);
});

test('a connected-app name in an explanatory question does not trigger the live-source gate', async () => {
  const prisma = { pendingWrite: {} };
  let planInput;
  const result = await runUnifiedMetaAgent({
    message: 'What does Gmail do?', useTools: true, prisma,
    ctx: { orgId: 'org', userId: 'user', threadId: 'gmail-explainer', language: 'en', prisma },
    checkpointer: new MemorySaver(),
    composio: { async listConnectedAccounts() { return [{ toolkit: 'gmail', status: 'ACTIVE' }]; } },
    decisionStage: async input => {
      planInput = input;
      return { status: 'selected', selected: 'direct_answer', authoritative: true, receipt: { source: 'jev', probability: 0.98, margin: 0.9 } };
    },
    modelStep: async () => ({ message: { role: 'assistant', content: 'Gmail is Google’s email service.' } }),
  });
  assert.equal(result.status, 'completed');
  assert.equal(planInput.operational_app_intent, false);
  assert.deepEqual(planInput.app_mentions, []);
  assert.equal(planInput.context.connected_source_intent, null);
});

test('LangGraph pauses on JEV connected-read intent when tools are off, then resumes the same plan after approval', async () => {
  const checkpointer = new MemorySaver();
  const prisma = { pendingWrite: {} };
  const surfaces = [];
  const connectedCalls = [];
  let planCalls = 0;
  let modelCalls = 0;
  const common = {
    message: 'Check Gmail for my latest email', useTools: false, prisma, checkpointer,
    ctx: { orgId: 'org', userId: 'user', threadId: 'tools-consent-approve', language: 'en', prisma },
    decisionStage: async () => {
      planCalls += 1;
      return { status: 'selected', selected: 'composio_read', authoritative: true, receipt: { source: 'jev', probability: 0.97 } };
    },
    modelStep: async ({ tools }) => {
      modelCalls += 1;
      surfaces.push(tools.map(tool => tool.function.name));
      if (modelCalls === 1) return { message: { role: 'assistant', content: null, tool_calls: [{
        id: 'search', type: 'function', function: { name: 'hivemind_connected_task', arguments: JSON.stringify({ action: 'search', queries: ['latest email'], toolkits: ['gmail'] }) },
      }] } };
      if (modelCalls === 2) return { message: { role: 'assistant', content: null, tool_calls: [{
        id: 'execute', type: 'function', function: { name: 'hivemind_connected_task', arguments: JSON.stringify({ action: 'execute', tool_slug: 'GMAIL_LIST_MESSAGES', arguments: { query: 'in:inbox', max_results: 1 } }) },
      }] } };
      throw new Error('unexpected_model_call');
    },
    connectedExecutor: async args => {
      connectedCalls.push(args.action);
      if (args.action === 'search') return {
        successful: true, status: 'ok',
        data: { results: [{ primary_tool_slugs: ['GMAIL_LIST_MESSAGES'] }] },
        state: { sessionId: 'session-1', selectedSlugs: ['GMAIL_LIST_MESSAGES'], primarySlugs: ['GMAIL_LIST_MESSAGES'] },
      };
      return { successful: true, status: 'executed', data: { messages: [{ subject: 'Real latest email' }] } };
    },
    finalStream: async ({ onDelta }) => {
      await onDelta('Your latest email is ...');
      return { content: 'Your latest email is ...', usage: null };
    },
  };

  const paused = await runUnifiedMetaAgent(common);
  assert.equal(paused.status, 'needs_input');
  assert.equal(paused.inputRequests[0].kind, 'enable_tools');
  assert.match(paused.inputRequests[0].prompt, /Hivemind wants to use connected tools/);
  assert.deepEqual(paused.inputRequests[0].options.map(option => option.id), ['approve_tools', 'decline_tools']);
  assert.equal(paused.resumeState.kind, 'unified_langgraph');
  assert.deepEqual(connectedCalls, [], 'no connector operation runs before approval');
  assert.equal(modelCalls, 0, 'no chat-model tool syntax is emitted before consent');

  const resumed = await runUnifiedMetaAgent({
    ...common,
    ctx: { ...common.ctx, unifiedGraphThreadId: paused.resumeState.graph_thread_id, unifiedRunId: paused.resumeState.run_id },
    choice: { action: 'approve_tools', option_id: 'approve_tools', value: 'approve', run_id: paused.resumeState.run_id },
  });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.response, 'Your latest email is ...');
  assert.deepEqual(connectedCalls, ['search', 'execute']);
  assert.deepEqual(surfaces, [['hivemind_connected_task'], ['hivemind_connected_task']]);
  assert.equal(planCalls, 1, 'approval resumes the checkpoint without another JEV plan call');
});

test('a connected-source follow-up survives a conflicting JEV memory route and resumes the same graph', async () => {
  const checkpointer = new MemorySaver();
  const prisma = { pendingWrite: {} };
  const surfaces = [];
  const connectedCalls = [];
  const events = [];
  let planCalls = 0;
  let modelCalls = 0;
  const common = {
    message: 'search again', useTools: false, prisma, checkpointer,
    ctx: {
      orgId: 'org', userId: 'user', threadId: 'gmail-followup-source-constraint', language: 'en', prisma,
      conversationHistory: [
        { role: 'user', content: 'Get more information about Rama from Gmail' },
        { role: 'assistant', content: 'I only have the older saved-memory summary, not a fresh Gmail result.' },
      ],
    },
    onEvent: event => events.push(event),
    decisionStage: async input => {
      planCalls += 1;
      assert.equal(input.stage, 'capability');
      assert.deepEqual(input.app_mentions, ['gmail']);
      assert.equal(input.operational_app_intent, true);
      assert.deepEqual(input.context.connected_source_intent, {
        required: true, toolkits: ['gmail'], operation: 'composio_read',
        request_text: 'Get more information about Rama from Gmail', origin: 'recent_source_followup',
      });
      return { status: 'selected', selected: 'hivemind_memory_lookup', authoritative: true,
        receipt: { source: 'jev', probability: 0.94, margin: 0.72, requestId: 'wrong-memory-route',
          diagnostics: { choice: 'hivemind_memory_lookup', probability: 0.94, margin: 0.72 } } };
    },
    modelStep: async ({ tools, messages }) => {
      modelCalls += 1;
      surfaces.push(tools.map(tool => tool.function.name));
      const executor = messages.find(row => row.role === 'system' && row.content.includes('Selected executor intent:'))?.content || '';
      assert.match(executor, /MANDATORY CONNECTED-SOURCE TASK/i);
      assert.match(executor, /Use gmail as the live source/i);
      assert.match(executor, /Get more information about Rama from Gmail/i);
      assert.match(executor, /Do not answer from HIVE memory\/profile or web instead/i);
      if (modelCalls === 1) {
        assert.deepEqual(tools.map(tool => tool.function.name), ['hivemind_connected_task']);
        return { message: { role: 'assistant', content: null, tool_calls: [{
          id: 'gmail-search', type: 'function', function: { name: 'hivemind_connected_task', arguments: JSON.stringify({
            action: 'search', toolkits: ['gmail'], queries: [{ use_case: 'Search Gmail for emails from Rama Santhoshi; return the latest matching messages with sender, subject, date, and snippet.' }],
          }) },
        }] } };
      }
      if (modelCalls === 2) {
        assert.deepEqual(tools.map(tool => tool.function.name), ['hivemind_connected_task']);
        return { message: { role: 'assistant', content: null, tool_calls: [{
          id: 'gmail-execute', type: 'function', function: { name: 'hivemind_connected_task', arguments: JSON.stringify({
            action: 'execute', tool_slug: 'GMAIL_LIST_MESSAGES', arguments: { query: 'from:ramasantoshi1206@gmail.com', max_results: 10 },
          }) },
        }] } };
      }
      throw new Error('the source-constrained task must not call HIVE or ask for another plan');
    },
    connectedExecutor: async args => {
      connectedCalls.push(args.action);
      if (args.action === 'search') return {
        successful: true, status: 'ok', data: { results: [{ primary_tool_slugs: ['GMAIL_LIST_MESSAGES'] }] },
        state: { sessionId: 'gmail-source-session', selectedSlugs: ['GMAIL_LIST_MESSAGES'], primarySlugs: ['GMAIL_LIST_MESSAGES'] },
      };
      return { successful: true, status: 'executed', data: { messages: [{ from: 'Rama Santhoshi', subject: 'Missing You', date: '2026-09-03' }] } };
    },
    metaExecutor: async () => { throw new Error('HIVE recall must not substitute for the requested Gmail source'); },
    finalStream: async ({ messages, onDelta }) => {
      assert.match(messages.at(-1).content, /Missing You/);
      await onDelta('I checked Gmail again and found Rama’s “Missing You” email from September 3, 2026.');
      return { content: 'I checked Gmail again and found Rama’s “Missing You” email from September 3, 2026.', usage: null };
    },
  };

  const paused = await runUnifiedMetaAgent(common);
  assert.equal(paused.status, 'needs_input');
  assert.deepEqual(paused.inputRequests[0].toolkits, ['gmail']);
  assert.equal(paused.inputRequests[0].kind, 'enable_tools');
  assert.deepEqual(connectedCalls, []);
  assert.equal(modelCalls, 0);
  const planEvent = events.find(event => event.type === 'decision' && event.stage === 'capability');
  assert.equal(planEvent.selected, null);
  assert.equal(planEvent.reason, 'explicit_connected_source_intent_conflict');
  assert.deepEqual(planEvent.diagnostics, { choice: 'hivemind_memory_lookup', probability: 0.94, margin: 0.72 });

  const resumed = await runUnifiedMetaAgent({
    ...common,
    ctx: { ...common.ctx, unifiedGraphThreadId: paused.resumeState.graph_thread_id, unifiedRunId: paused.resumeState.run_id },
    choice: { action: 'approve_tools', option_id: 'approve_tools', value: 'approve', run_id: paused.resumeState.run_id },
  });
  assert.equal(resumed.status, 'completed');
  assert.match(resumed.response, /checked Gmail again/i);
  assert.deepEqual(connectedCalls, ['search', 'execute']);
  assert.deepEqual(surfaces, [['hivemind_connected_task'], ['hivemind_connected_task']]);
  assert.equal(planCalls, 1, 'the same checkpoint resumes without a second JEV plan call');
  assert.ok(!resumed.steps.some(step => step.slug === 'hivemind_meta'));
});

test('declining LangGraph tool consent checks Hivemind only and returns a friendly streamed fallback', async () => {
  const checkpointer = new MemorySaver();
  const prisma = { pendingWrite: {} };
  let metaArgs = null;
  let modelCalls = 0;
  let connectedCalls = 0;
  const common = {
    message: 'Check Gmail for my latest email', useTools: false, prisma, checkpointer,
    ctx: { orgId: 'org', userId: 'user', threadId: 'tools-consent-decline', language: 'en', prisma },
    decisionStage: async () => ({ status: 'selected', selected: 'composio_read', authoritative: true, receipt: { source: 'jev', probability: 0.97 } }),
    modelStep: async () => { modelCalls += 1; throw new Error('decline fallback should use receipt synthesis'); },
    connectedExecutor: async () => { connectedCalls += 1; throw new Error('connected app must remain disabled'); },
    metaExecutor: async args => { metaArgs = args; return { successful: true, data: { memories: [] } }; },
    finalStream: async ({ messages, onDelta }) => {
      assert.match(messages[0].content, /user declined connected tools/i);
      await onDelta('I could not check Gmail without permission.');
      return { content: 'I could not check Gmail without permission.', usage: null };
    },
  };
  const paused = await runUnifiedMetaAgent(common);
  const result = await runUnifiedMetaAgent({
    ...common,
    ctx: { ...common.ctx, unifiedGraphThreadId: paused.resumeState.graph_thread_id, unifiedRunId: paused.resumeState.run_id },
    choice: { action: 'decline_tools', option_id: 'decline_tools', value: 'decline', run_id: paused.resumeState.run_id },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(metaArgs, { operation: 'recall', recall: { query: common.message, mode: 'quick', limit: 5 } });
  assert.equal(modelCalls, 0);
  assert.equal(connectedCalls, 0);
});
