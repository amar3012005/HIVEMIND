import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSlackProgressReporter,
  mergeSlackStage,
  renderSlackProgress,
  slackStageFromAgentEvent,
} from '../../src/connectors/slack-agent-progress.js';

test('native recall tool events update one stable Slack stage', () => {
  let stages = [];
  stages = mergeSlackStage(stages, slackStageFromAgentEvent({ type: 'tool_call', name: 'hivemind_recall' }));
  stages = mergeSlackStage(stages, slackStageFromAgentEvent({ type: 'tool_result', name: 'hivemind_recall', status: 'completed', summary: '4 memories' }));
  assert.equal(stages.length, 1);
  assert.equal(stages[0].status, 'completed');
  assert.match(renderSlackProgress(stages), /✓ 🧠 Recalling relevant memory — 4 memories/);
});

test('native save completion status renders as finished', () => {
  const stage = slackStageFromAgentEvent({
    type: 'tool_completed', name: 'hivemind_save_memory', status: 'ok', summary: 'saved',
  });
  assert.match(renderSlackProgress([stage]), /✓ 🧠 Preparing a memory — saved/);
});

test('compound steps retain provider identity and completion', () => {
  const stage = slackStageFromAgentEvent({
    type: 'orchestration_step', step_id: 'step-2', phase: 'started',
    tool_groups: ['gmail'], label: 'Find the latest email',
  });
  assert.equal(stage.key, 'step-2');
  assert.equal(stage.icon, '📧');
  assert.match(renderSlackProgress([stage]), /◌ 📧 Find the latest email/);
});

test('progress reporter serializes updates and stops before final answer', async () => {
  const sent = [];
  const reporter = createSlackProgressReporter({ update: async (text) => { sent.push(text); }, minIntervalMs: 0 });
  reporter.onEvent({ type: 'turn_accepted' });
  reporter.onEvent({ type: 'tool_call', name: 'hivemind_recall' });
  reporter.onEvent({ type: 'tool_result', name: 'hivemind_recall', status: 'completed', summary: 'ready' });
  await reporter.stop();
  const count = sent.length;
  reporter.onEvent({ type: 'finish' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sent.length, count);
  assert.match(sent.at(-1), /ready/);
});
