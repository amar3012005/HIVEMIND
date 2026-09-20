import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRuntimeStage, decisionGatewayToolNames } from '../../src/agent/decision-gateway-service.js';

function provider(choice = 'option_0', probabilities = { option_0: 0.96, option_1: 0.04 }) {
  return {
    async decideChoice() {
      const ids = ['direct_answer', 'hivemind_context', 'hivemind_meta', 'hivemind_save', 'composio_search', 'fallback_harness'];
      const selected = Number(choice.split('_')[1]);
      return {
        choice: ids[selected], probability: probabilities[choice],
        margin: probabilities[choice] - Math.max(0, ...Object.entries(probabilities).filter(([key]) => key !== choice).map(([, value]) => value)),
        probabilities: Object.fromEntries(Object.entries(probabilities).map(([key, value]) => [ids[Number(key.split('_')[1])], value])),
      };
    },
  };
}

test('off mode deterministically defers to the current selector', async () => {
  const result = await decideRuntimeStage({ stage: 'capability', user_query: 'hello' }, { env: {} });
  assert.deepEqual(result, { status: 'defer', mode: 'off', stage: 'capability', reason: 'decision_gateway_off' });
});

test('capability mapping returns only the schema family for the next model step', () => {
  assert.deepEqual(decisionGatewayToolNames('direct_answer'), []);
  assert.deepEqual(decisionGatewayToolNames('hivemind_meta'), ['hivemind_meta']);
  assert.deepEqual(decisionGatewayToolNames('hivemind_save'), ['hivemind_meta']);
  assert.deepEqual(decisionGatewayToolNames('composio_search'), ['hivemind_connected_task']);
  assert.equal(decisionGatewayToolNames('composio_search', { connected: false }), null);
  assert.equal(decisionGatewayToolNames('fallback_harness'), null);
});

test('shadow mode records a confident decision but is not authoritative', async () => {
  const result = await decideRuntimeStage({ stage: 'capability', user_query: 'hello' }, {
    env: { JEV_DECISION_GATEWAY_MODE: 'shadow' }, provider: provider(),
  });
  assert.equal(result.status, 'defer');
  assert.equal(result.selected, 'direct_answer');
  assert.equal(result.authoritative, false);
  assert.equal(result.receipt.source, 'jev');
});

test('active mode returns one accepted capability selection', async () => {
  const result = await decideRuntimeStage({ stage: 'capability', user_query: 'Find my last email', app_mentions: ['gmail'] }, {
    env: { JEV_DECISION_GATEWAY_MODE: 'active' }, provider: provider('option_4', { option_4: 0.98, option_0: 0.02 }),
  });
  assert.equal(result.status, 'selected');
  assert.equal(result.selected, 'composio_search');
  assert.equal(result.authoritative, true);
});

test('provider errors and low confidence stay fail-open to the current selector', async () => {
  const unavailable = await decideRuntimeStage({ stage: 'capability', user_query: 'Find my last email' }, {
    env: { JEV_DECISION_GATEWAY_MODE: 'active' },
    provider: { async decideChoice() { throw new Error('provider_down'); } },
  });
  assert.equal(unavailable.status, 'defer');
  assert.equal(unavailable.authoritative, false);
  assert.equal(unavailable.receipt.source, 'fallback');
  assert.match(unavailable.receipt.reason, /provider_down/);

  const uncertain = await decideRuntimeStage({ stage: 'capability', user_query: 'Find it' }, {
    env: { JEV_DECISION_GATEWAY_MODE: 'active' },
    provider: provider('option_0', { option_0: 0.51, option_1: 0.49 }),
  });
  assert.equal(uncertain.status, 'defer');
  assert.equal(uncertain.receipt.reason, 'decision_probability_below_threshold');
});
