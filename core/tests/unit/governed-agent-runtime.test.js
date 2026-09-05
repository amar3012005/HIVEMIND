import test from 'node:test';
import assert from 'node:assert/strict';
import { Command, MemorySaver } from '@langchain/langgraph';
import { assertLangSmithRedaction, createGovernedAgentGraph, governedGraphThreadId } from '../../src/agent/governed-agent-runtime.js';
import { isGovernedLangGraphRuntimeEnabled } from '../../src/agent/governed-agent-runtime-flag.js';
import { governedSkillIds, loadGovernedSkill } from '../../src/agent/governed-agent-skills.js';
import { buildProgressiveConversationContext, normalizeHistoryTurns } from '../../src/agent/progressive-harness.js';

test('governed runtime requires both Core opt-in and Cloudflare full mode', () => {
  assert.equal(isGovernedLangGraphRuntimeEnabled({ GOVERNED_LANGGRAPH_RUNTIME: 'true' }, { durableChatMode: 'full' }), true);
  for (const mode of ['off', 'shadow', 'session', 'workflow', undefined]) {
    assert.equal(isGovernedLangGraphRuntimeEnabled({ GOVERNED_LANGGRAPH_RUNTIME: 'true' }, { durableChatMode: mode }), false);
  }
  assert.equal(isGovernedLangGraphRuntimeEnabled({}, { durableChatMode: 'full' }), false);
});

test('LangSmith tracing fails closed unless inputs and outputs are hidden', () => {
  assert.equal(assertLangSmithRedaction({ LANGSMITH_TRACING: 'false' }), true);
  assert.equal(assertLangSmithRedaction({ LANGSMITH_TRACING: 'true', LANGSMITH_HIDE_INPUTS: 'true', LANGSMITH_HIDE_OUTPUTS: 'true' }), true);
  assert.throws(() => assertLangSmithRedaction({ LANGSMITH_TRACING: 'true' }), /langsmith_redaction_required/);
});

test('graph interrupts and resumes exactly one durable execution', async () => {
  const choices = [];
  const graph = createGovernedAgentGraph({
    checkpointer: new MemorySaver(),
    execute: async ({ choice }) => {
      choices.push(choice);
      if (!choice) return {
        status: 'needs_input', run: { id: 'run-1', status: 'waiting_user' },
        inputRequests: [{ kind: 'field_input', prompt: 'What should the email say?', fields: [{ name: 'body' }] }],
      };
      return { status: 'completed', run: { id: 'run-1', status: 'done' }, summary: choice.values.body };
    },
  });
  const config = { configurable: { thread_id: 'tenant-user-turn' } };
  const paused = await graph.invoke({ request: { message: 'send an email' } }, config);
  assert.equal(paused.result.status, 'needs_input');
  assert.equal(paused.__interrupt__.length, 1);

  const completed = await graph.invoke(new Command({ resume: { values: { body: 'About Singulance' } } }), config);
  assert.equal(completed.result.status, 'completed');
  assert.equal(completed.result.summary, 'About Singulance');
  assert.deepEqual(choices, [null, { values: { body: 'About Singulance' } }]);
});

test('thread identity is tenant, user, and turn scoped without exposing identifiers', () => {
  const first = governedGraphThreadId({ ctx: { orgId: 'org-a', userId: 'user-a', durableChatTurnId: 'turn-a' }, message: 'hello' });
  const same = governedGraphThreadId({ ctx: { orgId: 'org-a', userId: 'user-a', durableChatTurnId: 'turn-a' }, message: 'hello' });
  const other = governedGraphThreadId({ ctx: { orgId: 'org-a', userId: 'user-b', durableChatTurnId: 'turn-a' }, message: 'hello' });
  assert.equal(first, same);
  assert.notEqual(first, other);
  assert.equal(first.includes('org-a'), false);
  assert.equal(first.includes('user-a'), false);
});

test('progressive skills are individually bounded and load only by stage', () => {
  assert.deepEqual(governedSkillIds, ['intent', 'planning', 'arguments', 'hitl', 'synthesis']);
  for (const id of governedSkillIds) {
    const skill = loadGovernedSkill(id);
    assert.ok(skill.id.includes(`/${id}/`));
    assert.ok(skill.content.length < 500);
  }
  assert.throws(() => loadGovernedSkill('gmail'), /unknown_governed_skill/);
});

test('connected-agent history is server bounded from zero through twelve', () => {
  const history = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `turn-${index}` }));
  assert.deepEqual(buildProgressiveConversationContext(history, 0), []);
  assert.equal(buildProgressiveConversationContext(history, 12).length, 12);
  assert.equal(buildProgressiveConversationContext(history, 99).length, 6);
  assert.equal(normalizeHistoryTurns('12'), 12);
  assert.equal(normalizeHistoryTurns(13), 6);
});
